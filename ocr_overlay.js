// ocr_overlay.js

// This script is injected on-demand to handle the OCR region selection.
(() => {
    // Prevent duplicate execution.
    if (window.seeAndLearnOcrActive) return;
    window.seeAndLearnOcrActive = true;
  
    console.log("OCR overlay activated.");
  
    const overlay = document.createElement('div');
    // ... (Styling for overlay: fixed position, full screen, semi-transparent, crosshair)
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
      backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '999999',
      cursor: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path d="M8 0 V16 M0 8 H16" stroke="white" stroke-width="3"/><path d="M8 0 V16 M0 8 H16" stroke="white" stroke-width="1"/></svg>') 8 8, crosshair`
    });
    document.body.appendChild(overlay);
  
    let startX, startY, selectionBox;
      
    overlay.addEventListener('mousedown', e => {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
  
      selectionBox = document.createElement('div');
      // ... (Styling for selectionBox: absolute, dashed border)
      Object.assign(selectionBox.style, {
        position: 'absolute', border: '2px dashed #fff',
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
        left: `${startX}px`, top: `${startY}px`
      });
      overlay.appendChild(selectionBox);
  
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  
    function onMouseMove(e) {
      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const width = Math.abs(startX - e.clientX);
      const height = Math.abs(startY - e.clientY);
      Object.assign(selectionBox.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${width}px`, height: `${height}px`
      });
    }
  
    function onMouseUp(e) {
      // Cleanup
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.removeChild(overlay);
      window.seeAndLearnOcrActive = false;
  
      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const width = Math.abs(startX - e.clientX);
      const height = Math.abs(startY - e.clientY);
  
      if (width > 5 && height > 5) {
        const dpr = window.devicePixelRatio;
        const scaledRegion = {
          left: left * dpr, top: top * dpr,
          width: width * dpr, height: height * dpr
        };
        console.log("OCR overlay: Sending scaled region for capture:", scaledRegion);
        chrome.runtime.sendMessage({ action: "captureOcrRegion", payload: {scaledRegion, dpr: dpr} });
      }
    }
  })();