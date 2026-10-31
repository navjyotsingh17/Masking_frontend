"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Same-origin Next.js API route (app/api/mask/route.ts) that forwards to the masking service
const API_URL = "/api/mask";

const ACCEPTED_EXTENSIONS = ["tiff", "tif", "pdf", "jpeg", "jpg", "png"];
const ACCEPT_ATTR = ".tiff,.tif,.pdf,.jpeg,.jpg,.png";
const MAX_SIZE_MB = 20;

type Status = "idle" | "uploading" | "processing" | "done" | "error";

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function getExtension(name: string) {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Identify the real file type from its first bytes (magic numbers)
function detectMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const [a, b, c, d] = bytes;
  if (a === 0x25 && b === 0x50 && c === 0x44 && d === 0x46) return "application/pdf"; // %PDF
  if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return "image/png";
  if (a === 0xff && b === 0xd8 && c === 0xff) return "image/jpeg";
  if (
    (a === 0x49 && b === 0x49 && c === 0x2a && d === 0x00) ||
    (a === 0x4d && b === 0x4d && c === 0x00 && d === 0x2a)
  )
    return "image/tiff";
  return null;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64ToBlob(b64: string, mime: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [maskedBlob, setMaskedBlob] = useState<Blob | null>(null);
  const [maskedUrl, setMaskedUrl] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  // Revoke object URLs to avoid memory leaks
  useEffect(() => {
    return () => {
      if (maskedUrl) URL.revokeObjectURL(maskedUrl);
    };
  }, [maskedUrl]);

  const reset = useCallback(() => {
    xhrRef.current?.abort();
    setFile(null);
    setStatus("idle");
    setProgress(0);
    setError(null);
    setMaskedBlob(null);
    setMaskedUrl(null);
    setShowPreview(false);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const uploadFile = useCallback((selected: File) => {
    const ext = getExtension(selected.name);

    setStatus("uploading");
    setProgress(0);
    setError(null);
    setMaskedBlob(null);
    setMaskedUrl(null);
    setShowPreview(false);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", API_URL);
    xhr.responseType = "arraybuffer";

    // The API route adds X-Password, X-Output-Folder and page on the server.
    // HTTP header values must be ASCII/Latin-1, so encode unusual file names.
    const safeFilename = /^[\x20-\x7E]*$/.test(selected.name)
      ? selected.name
      : encodeURIComponent(selected.name);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-Filename", safeFilename);
    xhr.setRequestHeader("X-Mimetype", ext);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    // Upload finished, now waiting for the service to respond
    xhr.upload.onload = () => {
      setProgress(100);
      setStatus("processing");
    };

    xhr.onload = async () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        setError(`Masking service returned an error (HTTP ${xhr.status}). Please try again.`);
        setStatus("error");
        return;
      }

      try {
        let bytes = new Uint8Array(xhr.response as ArrayBuffer);

        // If the service wrapped the file as text (JSON or plain base64), unwrap it first
        if (detectMime(bytes) === null) {
          let b64 = new TextDecoder().decode(bytes).trim();
          if (b64.startsWith("{")) {
            const json = JSON.parse(b64);
            b64 = json.maskedDocument ?? json.document ?? json.data ?? json.file ?? "";
          }
          b64 = b64
            .replace(/^"|"$/g, "")
            .replace(/^data:[^;]+;base64,/, "")
            .replace(/\s/g, "")
            .replace(/-/g, "+")
            .replace(/_/g, "/");
          if (!b64) throw new Error("No Aadhaar numbers were found in the document.");
          bytes = base64ToBytes(b64);
        }

        // Bytes received -> base64 -> decode -> Blob with the correct MIME type
        const base64 = bytesToBase64(bytes);
        const mime = detectMime(bytes) ?? MIME_BY_EXT[ext] ?? "application/octet-stream";
        const blob = base64ToBlob(base64, mime);

        setMaskedBlob(blob);
        setMaskedUrl(URL.createObjectURL(blob));
        setStatus("done");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not read the service response.");
        setStatus("error");
      }
    };

    xhr.onerror = () => {
      setError("Network error. Could not reach the masking service.");
      setStatus("error");
    };
    xhr.onabort = () => undefined;

    // Convert the file to raw bytes and send them as the request body
    selected
      .arrayBuffer()
      .then((rawBytes) => xhr.send(rawBytes))
      .catch(() => {
        setError("Could not read the selected file.");
        setStatus("error");
      });
  }, []);

  const handleFile = useCallback(
    (selected: File | undefined | null) => {
      if (!selected) return;
      const ext = getExtension(selected.name);

      if (!ACCEPTED_EXTENSIONS.includes(ext)) {
        setFile(null);
        setError("Unsupported file type. Please upload a TIFF, PDF, JPEG or PNG file.");
        setStatus("error");
        return;
      }
      if (selected.size > MAX_SIZE_MB * 1024 * 1024) {
        setFile(null);
        setError(`File is too large. Maximum allowed size is ${MAX_SIZE_MB} MB.`);
        setStatus("error");
        return;
      }

      setFile(selected);
      uploadFile(selected);
    },
    [uploadFile]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (status === "uploading" || status === "processing") return;
    handleFile(e.dataTransfer.files?.[0]);
  };

  const handleDownload = () => {
    if (!maskedUrl || !file) return;
    const ext = getExtension(file.name);
    const base = file.name.replace(/\.[^/.]+$/, "");
    const a = document.createElement("a");
    a.href = maskedUrl;
    a.download = `${base}-masked.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const isBusy = status === "uploading" || status === "processing";
  const ext = file ? getExtension(file.name) : "";
  const isTiff = maskedBlob
    ? maskedBlob.type === "image/tiff"
    : ext === "tif" || ext === "tiff";
  const isPdf = maskedBlob ? maskedBlob.type === "application/pdf" : ext === "pdf";

  return (
    <main className="min-h-screen bg-linear-to-br from-slate-50 via-indigo-50 to-slate-100 px-4 py-12 text-slate-800">
      <style>{`
        @keyframes indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>

      <div className="mx-auto w-full max-w-3xl">
        {/* Header */}
        <header className="text-center">
          <h1 className="text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
            Aadhaar Masking
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm text-slate-500 sm:text-base">
            Upload your Aadhaar document and get back a copy with the sensitive number masked.
          </p>
        </header>

        {/* Card */}
        <section className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-indigo-100/50 sm:p-8">
          {/* Drop zone */}
          {status !== "done" && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!isBusy) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => !isBusy && inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && !isBusy) inputRef.current?.click();
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
                isBusy
                  ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-70"
                  : dragging
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-slate-300 bg-slate-50 hover:border-indigo-400 hover:bg-indigo-50/50"
              }`}
            >
              <svg
                className="h-12 w-12 text-indigo-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 16.5V4.5m0 0L7.5 9M12 4.5 16.5 9M4.5 15v3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-3"
                />
              </svg>
              <p className="mt-4 text-base font-semibold text-slate-700">
                Drag &amp; drop your document here
              </p>
              <p className="mt-1 text-sm text-slate-500">
                or <span className="font-medium text-indigo-600">browse files</span>
              </p>
              <p className="mt-3 text-xs text-slate-400">
                TIFF, PDF, JPEG, PNG &middot; up to {MAX_SIZE_MB} MB
              </p>
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT_ATTR}
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
                disabled={isBusy}
              />
            </div>
          )}

          {/* Selected file */}
          {file && (
            <div className="mt-6 flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-xs font-bold uppercase text-indigo-700">
                {ext}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-slate-800">{file.name}</p>
                <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
              </div>
              {!isBusy && (
                <button
                  onClick={reset}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                >
                  {status === "done" ? "Start over" : "Remove"}
                </button>
              )}
            </div>
          )}

          {/* Loader */}
          {isBusy && (
            <div className="mt-6" aria-live="polite">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium text-slate-700">
                  {status === "uploading" ? "Uploading document…" : "Masking your document…"}
                </span>
                {status === "uploading" && (
                  <span className="tabular-nums text-slate-500">{progress}%</span>
                )}
              </div>
              <div
                className="relative h-2.5 w-full overflow-hidden rounded-full bg-slate-200"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={status === "uploading" ? progress : undefined}
              >
                {status === "uploading" ? (
                  <div
                    className="h-full rounded-full bg-indigo-600 transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                ) : (
                  <div
                    className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-indigo-600"
                    style={{ animation: "indeterminate 1.4s ease-in-out infinite" }}
                  />
                )}
              </div>
              {status === "processing" && (
                <p className="mt-2 text-xs text-slate-500">
                  This can take a few moments. Please don&apos;t close this page.
                </p>
              )}
            </div>
          )}

          {/* Error */}
          {status === "error" && error && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <svg
                className="mt-0.5 h-5 w-5 shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                />
              </svg>
              <div className="flex-1">
                <p>{error}</p>
                {file && (
                  <button
                    onClick={() => uploadFile(file)}
                    className="mt-2 font-semibold underline underline-offset-2 hover:text-red-800"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Success */}
          {status === "done" && maskedUrl && (
            <div className="mt-6">
              <div className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">
                <svg
                  className="h-6 w-6 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.8}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
                  />
                </svg>
                <div>
                  <p className="text-sm font-semibold">Your document has been masked</p>
                  <p className="text-xs text-emerald-700">
                    Choose how you&apos;d like to use it.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button
                  onClick={() => setShowPreview((v) => !v)}
                  disabled={isTiff}
                  title={isTiff ? "TIFF files can't be previewed in the browser" : undefined}
                  className="flex items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-white px-5 py-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.8}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.25 12s3.75-6.75 9.75-6.75S21.75 12 21.75 12 18 18.75 12 18.75 2.25 12 2.25 12Z"
                    />
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 14.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z"
                    />
                  </svg>
                  {showPreview ? "Hide preview" : "View in browser"}
                </button>

                <button
                  onClick={handleDownload}
                  className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-200 transition hover:bg-indigo-700"
                >
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.8}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 4.5v11.25m0 0L7.5 11.25M12 15.75l4.5-4.5M4.5 18v.75A1.5 1.5 0 0 0 6 20.25h12a1.5 1.5 0 0 0 1.5-1.5V18"
                    />
                  </svg>
                  Download masked document
                </button>
              </div>

              {isTiff && (
                <p className="mt-3 text-xs text-slate-500">
                  Browsers can&apos;t display TIFF files, so in-browser preview is unavailable.
                  Please download the document instead.
                </p>
              )}

              {showPreview && !isTiff && (
                <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
                  {isPdf ? (
                    <>
                      <iframe
                        src={`${maskedUrl}#toolbar=1&navpanes=0`}
                        title="Masked document preview"
                        className="h-[70vh] w-full bg-white"
                      />
                      <a
                        href={maskedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block border-t border-slate-200 bg-white py-2 text-center text-xs font-medium text-indigo-600 hover:underline"
                      >
                        Open in a new tab
                      </a>
                    </>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={maskedUrl}
                      alt="Masked document preview"
                      className="mx-auto max-h-[70vh] w-auto object-contain"
                    />
                  )}
                </div>
              )}

              <div className="mt-6 text-center">
                <button
                  onClick={reset}
                  className="text-sm font-medium text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
                >
                  Mask another document
                </button>
              </div>
            </div>
          )}
        </section>

        <p className="mt-6 text-center text-xs text-slate-400">
          Your document is sent securely to the masking service and is not stored in this app.
        </p>
      </div>
    </main>
  );
}