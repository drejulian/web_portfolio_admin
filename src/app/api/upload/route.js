import { createHash } from 'node:crypto';

export const runtime = 'nodejs';

async function verifyFirebaseToken(token) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${process.env.NEXT_PUBLIC_FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
    },
  );
  const result = await response.json();
  if (!response.ok || !result.users?.[0]?.localId) throw new Error('Invalid Firebase authentication token.');
  return result.users[0].localId;
}

function getCloudinarySignature(params, secret) {
  const payload = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return createHash('sha1').update(`${payload}${secret}`).digest('hex');
}

function getCloudinarySignedDeliveryUrl(url, secret, transformation = '') {
  const parsedUrl = new URL(url);
  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  const uploadIndex = parts.indexOf('upload');
  if (uploadIndex === -1) throw new Error('Invalid Cloudinary delivery URL.');

  const deliveryPath = parts.slice(uploadIndex + 1).join('/');
  const pathToSign = transformation ? `${transformation}/${deliveryPath}` : deliveryPath;
  
  const digest = createHash('sha1')
    .update(`${pathToSign}${secret}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 8);
  
  if (transformation) {
    parts.splice(uploadIndex + 1, 0, `s--${digest}--`, transformation);
  } else {
    parts.splice(uploadIndex + 1, 0, `s--${digest}--`);
  }

  parsedUrl.pathname = `/${parts.join('/')}`;
  return parsedUrl.toString();
}

function getCloudinaryAsset(url) {
  const parsedUrl = new URL(url);
  if (parsedUrl.hostname !== 'res.cloudinary.com') throw new Error('Invalid Cloudinary URL.');

  const parts = parsedUrl.pathname.split('/').filter(Boolean);
  const uploadIndex = parts.indexOf('upload');
  if (uploadIndex < 1) throw new Error('Invalid Cloudinary asset URL.');

  const resourceType = parts[uploadIndex - 1];
  const assetParts = parts.slice(uploadIndex + 1);
  const versionIndex = assetParts.findIndex((part) => /^v\d+$/.test(part));
  const publicIdParts = versionIndex === -1
    ? assetParts
    : assetParts.slice(versionIndex + 1);
  if (!publicIdParts.length) throw new Error('Cloudinary public ID is missing.');

  const lastPartIndex = publicIdParts.length - 1;
  if (resourceType === 'image') {
    publicIdParts[lastPartIndex] = publicIdParts[lastPartIndex].replace(/\.[^./]+$/, '');
  }

  return { resourceType, publicId: publicIdParts.join('/') };
}

export async function POST(request) {
  try {
    const authorization = request.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : null;

    if (!token) {
      return Response.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const uid = await verifyFirebaseToken(token);
    if (uid !== process.env.FIREBASE_ADMIN_UID) {
      return Response.json({ error: 'Admin access required.' }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get('file');
    const folder = formData.get('folder');

    if (!(file instanceof File) || !['cv', 'projects'].includes(folder)) {
      return Response.json({ error: 'Invalid upload request.' }, { status: 400 });
    }

    const isValidType = folder === 'cv'
      ? file.type === 'application/pdf'
      : file.type.startsWith('image/');
    if (!isValidType) {
      return Response.json({
        error: folder === 'cv' ? 'CV must be a PDF file.' : 'Project image must be an image file.',
      }, { status: 400 });
    }

    if (file.size > 10 * 1024 * 1024) {
      return Response.json({ error: 'File must be 10 MB or smaller.' }, { status: 413 });
    }

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      return Response.json({ error: 'Cloudinary server configuration is missing.' }, { status: 500 });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const resourceType = folder === 'cv' ? 'raw' : 'image';
    const uploadParams = { folder, timestamp };
    
    const cloudinaryData = new FormData();
    cloudinaryData.append('file', file);
    cloudinaryData.append('api_key', apiKey);
    cloudinaryData.append('folder', folder);
    cloudinaryData.append('resource_type', resourceType);
    cloudinaryData.append('timestamp', String(timestamp));
    cloudinaryData.append('signature', getCloudinarySignature(uploadParams, apiSecret));

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`,
      { method: 'POST', body: cloudinaryData },
    );
    const result = await response.json();

    if (!response.ok) {
      return Response.json({ error: result.error?.message || 'Cloudinary upload failed.' }, { status: 502 });
    }

    if (!result.secure_url) {
      return Response.json({ error: 'Cloudinary did not return a file URL.' }, { status: 502 });
    }

    const finalUrl = folder === 'cv' 
      ? result.secure_url
      : getCloudinarySignedDeliveryUrl(result.secure_url, apiSecret);
    
    return Response.json({ url: finalUrl });
  } catch (error) {
    console.error('Cloudinary upload failed:', error);
    return Response.json({ error: 'Upload failed.' }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const authorization = request.headers.get('authorization');
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : null;
    if (!token) return Response.json({ error: 'Authentication required.' }, { status: 401 });

    const uid = await verifyFirebaseToken(token);
    if (uid !== process.env.FIREBASE_ADMIN_UID) {
      return Response.json({ error: 'Admin access required.' }, { status: 403 });
    }

    const { url } = await request.json();
    const { resourceType, publicId } = getCloudinaryAsset(url);
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    if (!cloudName || !apiKey || !apiSecret) {
      return Response.json({ error: 'Cloudinary server configuration is missing.' }, { status: 500 });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const destroyParams = {
      invalidate: 'true',
      public_id: publicId,
      timestamp,
      type: 'upload',
    };
    const cloudinaryData = new URLSearchParams({
      api_key: apiKey,
      invalidate: 'true',
      public_id: publicId,
      resource_type: resourceType,
      signature: getCloudinarySignature(destroyParams, apiSecret),
      timestamp: String(timestamp),
      type: 'upload',
    });
    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/destroy`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: cloudinaryData },
    );
    const result = await response.json();
    if (!response.ok || !['ok', 'not found'].includes(result.result)) {
      return Response.json({ error: result.error?.message || 'Cloudinary delete failed.' }, { status: 502 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Cloudinary delete failed:', error);
    return Response.json({ error: error.message || 'Delete failed.' }, { status: 400 });
  }
}
