import { useState, useRef, useCallback, useEffect } from "react";
import "./App.css";

function App() {
  const [leftWidth, setLeftWidth] = useState(280);
  const draggingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseDown = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = Math.min(Math.max(e.clientX - rect.left, 120), rect.width - 200);
      setLeftWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const onResize = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setLeftWidth((w) => Math.min(Math.max(w, 120), Math.max(rect.width - 200, 120)));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="app" ref={containerRef}>
      <aside className="pane left" style={{ width: leftWidth }}>
        <div className="pane-label">Folder</div>
      </aside>
      <div className="splitter" onMouseDown={onMouseDown} />
      <main className="pane right">
        <div className="pane-label">Viewer</div>
      </main>
    </div>
  );
}

export default App;
