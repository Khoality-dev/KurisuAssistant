import { useState, useRef, useCallback, useEffect } from 'react';

interface CapturedPhoto {
  file: File;
  preview: string;
}

export function useWebcamCapture() {
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const webcamCanvasRef = useRef<HTMLCanvasElement>(null);

  const startWebcam = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
      setWebcamStream(stream);
    } catch (err) {
      throw new Error('Failed to access webcam. Check permissions.');
    }
  }, []);

  const stopWebcam = useCallback(() => {
    if (webcamStream) {
      webcamStream.getTracks().forEach((t) => t.stop());
      setWebcamStream(null);
    }
  }, [webcamStream]);

  const captureFrame = useCallback((): CapturedPhoto | null => {
    const video = webcamVideoRef.current;
    const canvas = webcamCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const bstr = atob(arr[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
    const file = new File([u8arr], `capture_${Date.now()}.jpg`, { type: mime });
    return { file, preview: dataUrl };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (webcamStream) {
        webcamStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [webcamStream]);

  return {
    webcamStream,
    webcamVideoRef,
    webcamCanvasRef,
    startWebcam,
    stopWebcam,
    captureFrame,
  };
}

export type { CapturedPhoto };
