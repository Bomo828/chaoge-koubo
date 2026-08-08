"use client";

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  radius: number;
  alpha: number;
  speed: number;
  drift: number;
  phase: number;
  gold: boolean;
};

type Orbit = {
  radiusX: number;
  radiusY: number;
  tilt: number;
  speed: number;
  phase: number;
  planetSize: number;
  tone: "gold" | "green" | "cream";
  direction: 1 | -1;
};

const orbits: Orbit[] = [
  { radiusX: 0.35, radiusY: 0.18, tilt: -0.22, speed: 0.0068, phase: 0.4, planetSize: 9, tone: "cream", direction: 1 },
  { radiusX: 0.5, radiusY: 0.28, tilt: 0.18, speed: 0.0049, phase: 2.1, planetSize: 13, tone: "green", direction: -1 },
  { radiusX: 0.67, radiusY: 0.37, tilt: -0.36, speed: 0.0035, phase: 4.4, planetSize: 17, tone: "gold", direction: 1 },
  { radiusX: 0.84, radiusY: 0.48, tilt: 0.12, speed: 0.0025, phase: 1.1, planetSize: 12, tone: "cream", direction: -1 },
  { radiusX: 1.04, radiusY: 0.59, tilt: -0.1, speed: 0.0017, phase: 3.2, planetSize: 20, tone: "green", direction: 1 },
];

function createParticles(width: number, height: number) {
  let seed = 24791;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  return Array.from({ length: 118 }, (_, index): Particle => ({
    x: width * (0.18 + random() * 0.82),
    y: height * (0.04 + random() * 0.92),
    radius: 0.45 + random() * 1.75,
    alpha: 0.16 + random() * 0.54,
    speed: 0.12 + random() * 0.38,
    drift: (random() - 0.5) * 0.28,
    phase: random() * Math.PI * 2,
    gold: index % 4 !== 0,
  }));
}

export function ParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let frame = 0;
    let animationFrame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      particles = createParticles(width, height);
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "lighter";
      frame += reduceMotion ? 0 : 1;

      const mobile = width < 720;
      const systemScale = mobile
        ? Math.min(width * 0.98, height * 0.58)
        : Math.min(width * 0.53, height * 0.92);
      const centerX = width * (mobile ? 0.64 : 0.755) + pointerX * 14;
      const centerY = height * (mobile ? 0.69 : 0.515) + pointerY * 9;
      const time = frame;

      const drawGlow = (x: number, y: number, radius: number, rgb: string, alpha: number) => {
        const glow = context.createRadialGradient(x, y, 0, x, y, radius * 4.8);
        glow.addColorStop(0, `rgba(${rgb},${alpha})`);
        glow.addColorStop(0.15, `rgba(${rgb},${alpha * 0.72})`);
        glow.addColorStop(0.42, `rgba(${rgb},${alpha * 0.2})`);
        glow.addColorStop(1, `rgba(${rgb},0)`);
        context.fillStyle = glow;
        context.beginPath();
        context.arc(x, y, radius * 4.8, 0, Math.PI * 2);
        context.fill();
      };

      const sunPulse = 0.18 + Math.sin(time * 0.028) * 0.045;
      drawGlow(centerX, centerY, mobile ? 40 : 64, "87,224,150", sunPulse);

      context.save();
      context.translate(centerX, centerY);
      context.rotate(time * 0.00045);
      context.lineWidth = 1;
      context.strokeStyle = "rgba(217,179,106,.13)";
      context.beginPath();
      context.arc(0, 0, systemScale * 0.205, -0.55, 1.18);
      context.stroke();
      context.strokeStyle = "rgba(102,228,157,.1)";
      context.beginPath();
      context.arc(0, 0, systemScale * 0.235, 2.05, 4.52);
      context.stroke();
      context.restore();

      for (const [orbitIndex, orbit] of orbits.entries()) {
        const radiusX = systemScale * orbit.radiusX;
        const radiusY = systemScale * orbit.radiusY;
        const angle = orbit.phase + time * orbit.speed * orbit.direction;
        const cosTilt = Math.cos(orbit.tilt);
        const sinTilt = Math.sin(orbit.tilt);

        context.save();
        context.translate(centerX, centerY);
        context.rotate(orbit.tilt);
        context.setLineDash(orbitIndex % 2 === 0 ? [1.4, 7] : [2, 11]);
        context.lineDashOffset = -time * (0.05 + orbitIndex * 0.012) * orbit.direction;
        context.lineWidth = orbitIndex === orbits.length - 1 ? 1.15 : 0.8;
        context.strokeStyle = orbit.tone === "green"
          ? `rgba(100,225,158,${0.26 + orbitIndex * 0.02})`
          : `rgba(218,179,104,${0.22 + orbitIndex * 0.024})`;
        context.beginPath();
        context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
        context.stroke();
        context.restore();

        const pointAt = (value: number) => {
          const localX = Math.cos(value) * radiusX;
          const localY = Math.sin(value) * radiusY;
          return {
            x: centerX + localX * cosTilt - localY * sinTilt,
            y: centerY + localX * sinTilt + localY * cosTilt,
          };
        };

        const rgb = orbit.tone === "green"
          ? "95,230,158"
          : orbit.tone === "cream"
            ? "255,227,170"
            : "224,178,91";

        const planet = pointAt(angle);
        const safeBoundary = width * 0.49;
        const planetVisibility = mobile
          ? 1
          : Math.max(0, Math.min(1, (planet.x - safeBoundary) / (width * 0.08)));
        context.save();
        context.globalAlpha = planetVisibility;

        for (let trail = 18; trail >= 1; trail -= 1) {
          const trailPoint = pointAt(angle - trail * 0.012 * orbit.direction);
          const trailAlpha = (1 - trail / 19) * 0.11;
          drawGlow(trailPoint.x, trailPoint.y, Math.max(0.55, orbit.planetSize * 0.16), rgb, trailAlpha);
        }

        const depth = 0.72 + (Math.sin(angle) + 1) * 0.17;
        const planetRadius = orbit.planetSize * depth * (mobile ? 0.72 : 1);
        drawGlow(planet.x, planet.y, planetRadius, rgb, 0.84);

        const body = context.createRadialGradient(
          planet.x - planetRadius * 0.36,
          planet.y - planetRadius * 0.42,
          planetRadius * 0.08,
          planet.x,
          planet.y,
          planetRadius,
        );
        body.addColorStop(0, "rgba(255,247,218,.98)");
        body.addColorStop(0.22, `rgba(${rgb},.96)`);
        body.addColorStop(1, `rgba(${rgb},.18)`);
        context.fillStyle = body;
        context.beginPath();
        context.arc(planet.x, planet.y, planetRadius, 0, Math.PI * 2);
        context.fill();

        if (orbitIndex === 2 || orbitIndex === 4) {
          context.save();
          context.translate(planet.x, planet.y);
          context.rotate(orbit.tilt + 0.34);
          context.strokeStyle = `rgba(${rgb},.58)`;
          context.lineWidth = 1;
          context.beginPath();
          context.ellipse(0, 0, planetRadius * 1.75, planetRadius * 0.48, 0, 0, Math.PI * 2);
          context.stroke();
          context.restore();
        }

        if (orbitIndex === 2) {
          const moonAngle = time * 0.018;
          const moonX = planet.x + Math.cos(moonAngle) * planetRadius * 2.35;
          const moonY = planet.y + Math.sin(moonAngle) * planetRadius * 0.8;
          context.strokeStyle = "rgba(255,226,167,.34)";
          context.lineWidth = 0.7;
          context.beginPath();
          context.ellipse(planet.x, planet.y, planetRadius * 2.35, planetRadius * 0.8, 0, 0, Math.PI * 2);
          context.stroke();
          drawGlow(moonX, moonY, Math.max(2.2, planetRadius * 0.22), "255,232,188", 0.72);
        }
        context.restore();
      }

      for (const particle of particles) {
        const pulse = 0.55 + Math.sin(frame * 0.018 * particle.speed + particle.phase) * 0.45;
        const x = particle.x + Math.sin(frame * 0.004 + particle.phase) * 14 + pointerX * 12;
        const y = particle.y + Math.cos(frame * 0.003 + particle.phase) * 10 + pointerY * 8;
        const glow = particle.radius * (2.6 + pulse * 2.2);
        const color = particle.gold ? "215,177,103" : "101,219,157";
        const gradient = context.createRadialGradient(x, y, 0, x, y, glow);
        gradient.addColorStop(0, `rgba(${color},${particle.alpha * pulse})`);
        gradient.addColorStop(0.28, `rgba(${color},${particle.alpha * pulse * 0.45})`);
        gradient.addColorStop(1, `rgba(${color},0)`);
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(x, y, glow, 0, Math.PI * 2);
        context.fill();

        particle.y += reduceMotion ? 0 : particle.drift * 0.12;
        if (particle.y < -8) particle.y = height + 8;
        if (particle.y > height + 8) particle.y = -8;
      }

      context.globalCompositeOperation = "source-over";

      if (!reduceMotion) animationFrame = window.requestAnimationFrame(draw);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointerX = event.clientX / Math.max(window.innerWidth, 1) - 0.5;
      pointerY = event.clientY / Math.max(window.innerHeight, 1) - 0.5;
    };

    resize();
    draw();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);

  return <canvas ref={canvasRef} className="particle-canvas" aria-hidden="true" />;
}
