"use client";

import { useEffect, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  ref,
  uploadBytes,
  uploadBytesResumable,
} from "firebase/storage";
import { auth, db, storage } from "@/lib/firebase";
import "./styles.css";

const emptyProject = {
  title: "",
  description: "",
  projectUrl: "",
  imageUrls: [],
  isSelected: true,
  order: 0,
};

export default function Home() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState({ email: "", password: "" });
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(emptyProject);
  const [editingId, setEditingId] = useState(null);
  const [cvUrl, setCvUrl] = useState("");
  const [cvInput, setCvInput] = useState("");
  const [status, setStatus] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isReordering, setIsReordering] = useState(false);

  useEffect(
    () =>
      onAuthStateChanged(auth, async (currentUser) => {
        setUser(currentUser);
        setLoading(false);
        if (currentUser) await loadContent();
      }),
    [],
  );

  async function loadContent() {
    try {
      const snapshot = await getDocs(
        query(collection(db, "projects"), orderBy("order", "asc")),
      );
      setProjects(
        snapshot.docs.map((item) => {
          const data = item.data();
          if (data.imageUrl && !data.imageUrls) {
            return { id: item.id, ...data, imageUrls: [data.imageUrl] };
          }
          if (!data.imageUrls) {
            return { id: item.id, ...data, imageUrls: [] };
          }
          return { id: item.id, ...data };
        }),
      );
      const portfolio = await getDoc(doc(db, "settings", "portfolio"));
      const cvUrlFromDb = portfolio.data()?.cvUrl || "";
      setCvUrl(cvUrlFromDb);
      setCvInput(cvUrlFromDb);
    } catch (error) {
      console.error("Unable to load admin content:", error);
      setStatus(
        "Firestore permission denied. Publish firestore.rules and verify the admin UID.",
      );
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setStatus("Signing in...");
    try {
      await signInWithEmailAndPassword(
        auth,
        credentials.email,
        credentials.password,
      );
      setStatus("");
    } catch {
      setStatus("Login failed. Check your Firebase admin account.");
    }
  }

  async function uploadFile(file, folder) {
    const token = await auth.currentUser.getIdToken();
    const formData = new FormData();
    formData.append("file", file);
    formData.append("folder", folder);

    const response = await fetch("/api/upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const responseText = await response.text();
    let result = {};
    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      throw new Error(
        `Upload endpoint returned an invalid response (${response.status}).`,
      );
    }
    if (!response.ok) throw new Error(result.error || "Upload failed.");
    return result.url;
  }

  async function handleCvUrlSave() {
    if (!cvInput.trim()) {
      setStatus("Error: URL CV tidak boleh kosong.");
      return;
    }
    
    setStatus("Saving CV URL...");
    try {
      let finalUrl = cvInput.trim();
      
      if (finalUrl.includes('drive.google.com')) {
        const match = finalUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match) {
          const fileId = match[1];
          finalUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        }
      }
      
      await setDoc(
        doc(db, "settings", "portfolio"),
        { cvUrl: finalUrl, updatedAt: Date.now() },
        { merge: true },
      );
      
      setCvUrl(finalUrl);
      setStatus("CV URL berhasil disimpan.");
    } catch (error) {
      console.error("Unable to save CV URL:", error);
      setStatus(error.message || "Gagal menyimpan CV URL.");
    }
  }

  async function handleCvUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    
    if (file.type !== "application/pdf") {
      setStatus("Error: File harus berformat PDF.");
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      setStatus("Error: Ukuran file maksimal 10MB.");
      return;
    }
    
    setStatus("Uploading CV via Cloudinary...");
    setUploadProgress(10);
    
    try {
      if (!auth.currentUser) {
        throw new Error("Session login sudah berakhir. Silakan login ulang.");
      }
      
      setUploadProgress(20);
      const url = await uploadFile(file, "cv");
      setUploadProgress(80);
      
      await setDoc(
        doc(db, "settings", "portfolio"),
        { cvUrl: url, updatedAt: Date.now() },
        { merge: true },
      );
      
      setCvUrl(url);
      setUploadProgress(100);
      setStatus("CV berhasil diupload.");
      
      setTimeout(() => setUploadProgress(0), 1500);
    } catch (error) {
      console.error("Unable to upload CV:", error);
      setUploadProgress(0);
      setStatus(error.message || "Upload gagal.");
    }
  }

  async function handleCvDelete() {
    if (!cvUrl || !window.confirm("Delete the current CV?")) return;
    setStatus("Deleting CV...");
    try {
      if (cvUrl.includes("firebasestorage.googleapis.com")) {
        await deleteObject(ref(storage, "cv/resume.pdf"));
      } else {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch("/api/upload", {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: cvUrl }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Delete failed.");
      }
      await setDoc(
        doc(db, "settings", "portfolio"),
        { cvUrl: "" },
        { merge: true },
      );
      setCvUrl("");
      setStatus("CV deleted. You can upload a new PDF.");
    } catch (error) {
      console.error("Unable to delete CV:", error);
      setStatus(error.message);
    }
  }

  async function handleImageUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setStatus("Uploading project image...");
    try {
      const url = await uploadFile(file, "projects");
      setProject((current) => ({ 
        ...current, 
        imageUrls: [...(current.imageUrls || []), url] 
      }));
      setStatus("Project image added.");
      event.target.value = "";
    } catch (error) {
      console.error("Unable to upload project image:", error);
      setStatus(error.message);
    }
  }

  function handleImageDelete(index) {
    setProject((current) => ({
      ...current,
      imageUrls: current.imageUrls.filter((_, i) => i !== index),
    }));
    setStatus("Image removed.");
  }

  async function handleProjectSubmit(event) {
    event.preventDefault();
    setStatus("Saving project...");
    try {
      const payload = {
        ...project,
        order: Number(project.order) || 0,
        updatedAt: Date.now(),
      };
      if (editingId) await updateDoc(doc(db, "projects", editingId), payload);
      else
        await addDoc(collection(db, "projects"), {
          ...payload,
          createdAt: Date.now(),
        });
      setProject(emptyProject);
      setEditingId(null);
      await loadContent();
      setStatus("Project saved.");
    } catch (error) {
      console.error("Unable to save project:", error);
      setStatus(
        "Project could not be saved. Check Firestore rules and admin UID.",
      );
    }
  }

  async function handleDelete(id) {
    if (!window.confirm("Delete this project?")) return;
    try {
      await deleteDoc(doc(db, "projects", id));
      await loadContent();
      setStatus("Project deleted.");
    } catch (error) {
      console.error("Unable to delete project:", error);
      setStatus(
        "Project could not be deleted. Check Firestore rules and admin UID.",
      );
    }
  }

  async function handleMoveProject(id, direction) {
    const currentIndex = projects.findIndex((item) => item.id === id);
    const nextIndex = currentIndex + direction;
    if (
      isReordering ||
      currentIndex < 0 ||
      nextIndex < 0 ||
      nextIndex >= projects.length
    ) {
      return;
    }

    const reorderedProjects = [...projects];
    [reorderedProjects[currentIndex], reorderedProjects[nextIndex]] = [
      reorderedProjects[nextIndex],
      reorderedProjects[currentIndex],
    ];

    setIsReordering(true);
    setStatus("Updating project order...");
    try {
      const batch = writeBatch(db);
      const updatedAt = Date.now();
      reorderedProjects.forEach((item, index) => {
        batch.update(doc(db, "projects", item.id), {
          order: index,
          updatedAt,
        });
      });
      await batch.commit();
      setProjects(
        reorderedProjects.map((item, index) => ({ ...item, order: index })),
      );
      setStatus("Project order updated.");
    } catch (error) {
      console.error("Unable to reorder projects:", error);
      setStatus(
        "Project order could not be updated. Check Firestore rules and admin UID.",
      );
    } finally {
      setIsReordering(false);
    }
  }

  if (loading)
    return (
      <main className="shell">
        <p>Loading admin...</p>
      </main>
    );
  if (!user)
    return (
      <main className="login shell">
        <section>
          <p className="eyebrow">PORTFOLIO CONTROL</p>
          <h1>Welcome back.</h1>
          <p className="muted">Sign in to manage your CV and selected work.</p>
          <form onSubmit={handleLogin}>
            <input
              type="email"
              placeholder="Admin email"
              value={credentials.email}
              onChange={(event) =>
                setCredentials({ ...credentials, email: event.target.value })
              }
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={credentials.password}
              onChange={(event) =>
                setCredentials({ ...credentials, password: event.target.value })
              }
              required
            />
            <button type="submit">Sign in</button>
          </form>
          <p className="status">{status}</p>
        </section>
      </main>
    );

  return (
    <main className="shell dashboard">
      <header>
        <div>
          <p className="eyebrow">PORTFOLIO CONTROL</p>
          <h1>Content studio</h1>
          <p className="muted" style={{ fontSize: '12px' }}>UID: {user?.uid}</p>
        </div>
        <button className="secondary" onClick={() => signOut(auth)}>
          Sign out
        </button>
      </header>
      <p className="status">{status}</p>
      <section className="panel cv-panel">
        <div>
          <p className="eyebrow">RESUME</p>
          <h2>CV Link</h2>
          <p className="muted">
            Upload CV ke Google Drive, lalu paste link disini.
          </p>
          {cvUrl && (
            <div className="actions">
              <a href={cvUrl} target="_blank" rel="noreferrer">
                Preview CV
              </a>
              <button className="danger" type="button" onClick={handleCvDelete}>
                Remove
              </button>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', minWidth: '300px' }}>
          <input
            type="url"
            placeholder="https://drive.google.com/file/d/..."
            value={cvInput}
            onChange={(e) => setCvInput(e.target.value)}
            style={{ width: '100%', padding: '13px 14px' }}
          />
          <button type="button" onClick={handleCvUrlSave}>
            Save CV Link
          </button>
        </div>
      </section>
      <div className="content-grid">
        <section className="panel">
          <p className="eyebrow">WORK</p>
          <h2>{editingId ? "Edit project" : "Add project"}</h2>
          <form onSubmit={handleProjectSubmit}>
            <input
              placeholder="Project title"
              value={project.title}
              onChange={(event) =>
                setProject({ ...project, title: event.target.value })
              }
              required
            />
            <textarea
              placeholder="Short description"
              rows="4"
              value={project.description}
              onChange={(event) =>
                setProject({ ...project, description: event.target.value })
              }
              required
            />
            <input
              type="url"
              placeholder="Project URL"
              value={project.projectUrl}
              onChange={(event) =>
                setProject({ ...project, projectUrl: event.target.value })
              }
            />
            <label className="upload-button wide">
              {project.imageUrls?.length > 0 ? "Add another image" : "Upload images"}
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
              />
            </label>
            {project.imageUrls?.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px', marginTop: '12px' }}>
                {project.imageUrls.map((url, index) => (
                  <div key={index} style={{ position: 'relative', aspectRatio: '16/9', borderRadius: '8px', overflow: 'hidden', border: '2px solid #e5e7eb' }}>
                    <img
                      src={url}
                      alt={`Project image ${index + 1}`}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                    <button
                      type="button"
                      onClick={() => handleImageDelete(index)}
                      style={{
                        position: 'absolute',
                        top: '4px',
                        right: '4px',
                        background: 'rgba(239, 68, 68, 0.9)',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        padding: '4px 8px',
                        fontSize: '12px',
                        cursor: 'pointer',
                        fontWeight: '600'
                      }}
                    >
                      Delete
                    </button>
                    <div style={{
                      position: 'absolute',
                      bottom: '4px',
                      left: '4px',
                      background: 'rgba(0, 0, 0, 0.7)',
                      color: 'white',
                      borderRadius: '4px',
                      padding: '2px 6px',
                      fontSize: '11px',
                      fontWeight: '600'
                    }}>
                      #{index + 1}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <input
              type="number"
              placeholder="Display order"
              value={project.order}
              onChange={(event) =>
                setProject({ ...project, order: event.target.value })
              }
            />
            <label className="check">
              <input
                type="checkbox"
                checked={project.isSelected}
                onChange={(event) =>
                  setProject({ ...project, isSelected: event.target.checked })
                }
              />{" "}
              Show in Selected Work
            </label>
            <button type="submit">
              {editingId ? "Update project" : "Save project"}
            </button>
            {editingId && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setProject(emptyProject);
                  setEditingId(null);
                }}
              >
                Cancel edit
              </button>
            )}
          </form>
        </section>
        <section className="panel">
          <p className="eyebrow">LIBRARY</p>
          <h2>Projects</h2>
          <div className="project-list">
            {projects.map((item, index) => (
              <article key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p className="muted">
                    {item.isSelected ? "Selected" : "Hidden"} · order{" "}
                    {item.order}
                  </p>
                </div>
                <div className="actions">
                  <div className="reorder-actions">
                    <button
                      type="button"
                      className="secondary reorder-button"
                      aria-label={`Move ${item.title} up`}
                      title="Move up"
                      disabled={isReordering || index === 0}
                      onClick={() => handleMoveProject(item.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary reorder-button"
                      aria-label={`Move ${item.title} down`}
                      title="Move down"
                      disabled={isReordering || index === projects.length - 1}
                      onClick={() => handleMoveProject(item.id, 1)}
                    >
                      ↓
                    </button>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setProject(item);
                      setEditingId(item.id);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => handleDelete(item.id)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))}
            {projects.length === 0 && <p className="muted">No projects yet.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
