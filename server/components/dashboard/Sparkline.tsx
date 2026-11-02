'use client';

import { useEffect, useRef } from 'react';
import { cssVar } from '@/lib/client/format';

export default function Sparkline({ values }: { values: (number | null)[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    function draw() {
      const canvas = canvasRef.current;
      if (!canvas || !canvas.clientWidth) return;

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width * ratio;
      canvas.height = height * ratio;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, width, height);

      const points = values.filter((value): value is number => value !== null && value !== undefined);
      if (points.length < 2) return;

      let min = Math.min(...points);
      let max = Math.max(...points);
      if (max - min < 0.000001) {
        min -= 1;
        max += 1;
      }

      ctx.strokeStyle = cssVar('--ink-3');
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      points.forEach((value, index) => {
        const x = (index / (points.length - 1)) * (width - 2) + 1;
        const y = height - 2 - ((value - min) / (max - min)) * (height - 4);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [values]);

  return <canvas ref={canvasRef} aria-hidden="true" />;
}
