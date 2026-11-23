import { useEffect, useRef, type RefObject } from 'react';
import type {
  BroadcastSegment,
  CameraAngle,
  ChannelCategory,
  HostId,
  PermanentHost,
} from '../../shared/broadcastTypes';
import { broadcastAudioEngine } from '../audio/broadcastAudioEngine';

export type CartoonStylePreset = 'cel' | 'anime' | 'lofi';

interface CartoonBroadcastStageProps {
  segment: BroadcastSegment;
  primaryHost: PermanentHost;
  coHost?: PermanentHost;
  activeSpeakerId: HostId;
  cameraAngle: CameraAngle;
  audioEnabled: boolean;
  isInMusicInterlude: boolean;
  stylePreset: CartoonStylePreset;
  customAvatars: Partial<Record<HostId, string>>;
  canvasRefExternal?: RefObject<HTMLCanvasElement | null>;
}

interface HostPalette {
  skin: string;
  skinShadow: string;
  hair: string;
  hairHighlight: string;
  outfit: string;
  outfitAccent: string;
  shirt: string;
  eyeColor: string;
}

const HOST_PALETTES: Record<HostId, HostPalette> = {
  elena: {
    skin: '#F1C6A8',
    skinShadow: '#D7A07D',
    hair: '#24181C',
    hairHighlight: '#473038',
    outfit: '#1E2433',
    outfitAccent: '#E11D48',
    shirt: '#F8FAFC',
    eyeColor: '#1E293B',
  },
  marcus: {
    skin: '#8B573C',
    skinShadow: '#6B3E28',
    hair: '#151518',
    hairHighlight: '#2B2B32',
    outfit: '#26211D',
    outfitAccent: '#D97706',
    shirt: '#111827',
    eyeColor: '#18181B',
  },
  sora: {
    skin: '#F5D5BE',
    skinShadow: '#DEB498',
    hair: '#141B29',
    hairHighlight: '#32415E',
    outfit: '#14292B',
    outfitAccent: '#38BDF8',
    shirt: '#F1F5F9',
    eyeColor: '#0F172A',
  },
};

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function drawStudioBackdrop(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  channel: ChannelCategory,
  style: CartoonStylePreset,
  tSec: number,
  bpm: number,
  spectrum: number[]
) {
  // Base studio gradient
  const grad = ctx.createLinearGradient(0, 0, w, h);
  if (channel === 'news') {
    grad.addColorStop(0, style === 'lofi' ? '#131626' : '#091122');
    grad.addColorStop(0.55, '#0F1A32');
    grad.addColorStop(1, '#1A0E1B');
  } else if (channel === 'music') {
    grad.addColorStop(0, '#140F1B');
    grad.addColorStop(0.55, '#1F1510');
    grad.addColorStop(1, '#090B12');
  } else {
    grad.addColorStop(0, '#0B171D');
    grad.addColorStop(0.55, '#151E28');
    grad.addColorStop(1, '#1A1512');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Subtle architectural grid lines
  ctx.save();
  ctx.strokeStyle =
    channel === 'news'
      ? 'rgba(56, 189, 248, 0.08)'
      : channel === 'music'
        ? 'rgba(245, 158, 11, 0.08)'
        : 'rgba(52, 211, 153, 0.07)';
  ctx.lineWidth = 1;
  const gridGap = 64;
  for (let gx = (tSec * 12) % gridGap; gx < w; gx += gridGap) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, h);
    ctx.stroke();
  }
  for (let gy = 0; gy < h; gy += gridGap) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(w, gy);
    ctx.stroke();
  }
  ctx.restore();

  // Studio-specific background scenery
  if (channel === 'news') {
    // Rotating vector broadcast globe in upper-center background
    const cx = w * 0.42;
    const cy = h * 0.38;
    const radius = 190;
    ctx.save();
    ctx.strokeStyle = 'rgba(225, 29, 72, 0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(56, 189, 248, 0.16)';
    for (let i = -2; i <= 2; i++) {
      const yOff = i * 48;
      const halfSpan = Math.sqrt(Math.max(0, radius * radius - yOff * yOff));
      ctx.beginPath();
      ctx.moveTo(cx - halfSpan, cy + yOff);
      ctx.lineTo(cx + halfSpan, cy + yOff);
      ctx.stroke();
    }
    for (let m = 0; m < 4; m++) {
      const phase = ((tSec * 0.3 + m * 0.25) % 1) * Math.PI;
      const rx = Math.max(8, Math.abs(Math.cos(phase)) * radius);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, radius, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  } else if (channel === 'music') {
    // BPM-synced studio EQ towers & warm vinyl/synth halo
    const beatPulse = 0.5 + 0.5 * Math.sin(tSec * (bpm / 60) * Math.PI * 2);
    const halo = ctx.createRadialGradient(w * 0.36, h * 0.42, 20, w * 0.36, h * 0.42, 340);
    halo.addColorStop(0, `rgba(217, 119, 6, ${0.14 + beatPulse * 0.08})`);
    halo.addColorStop(1, 'rgba(217, 119, 6, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // Background animated studio spectrum bars
    const barCount = 24;
    const startX = w * 0.08;
    const spanW = w * 0.58;
    const barW = spanW / barCount - 6;
    for (let i = 0; i < barCount; i++) {
      const spec = spectrum[i % spectrum.length] ?? 0;
      const idleWave = 0.16 + 0.24 * Math.abs(Math.sin(tSec * 2.4 + i * 0.45));
      const amp = Math.max(idleWave, spec);
      const bh = 36 + amp * 190;
      const bx = startX + i * (barW + 6);
      const by = h * 0.72 - bh;
      ctx.fillStyle =
        i % 3 === 0 ? 'rgba(245, 158, 11, 0.24)' : 'rgba(251, 146, 60, 0.14)';
      drawRoundedRect(ctx, bx, by, barW, bh, 4);
      ctx.fill();
    }
  } else {
    // Studio C Culture Lounge: warm bokeh lanterns + architectural shelves
    for (let i = 0; i < 6; i++) {
      const lx = w * (0.1 + i * 0.11) + Math.sin(tSec * 0.5 + i) * 14;
      const ly = h * (0.2 + (i % 3) * 0.14) + Math.cos(tSec * 0.4 + i) * 10;
      const r = 42 + (i % 3) * 26;
      const glow = ctx.createRadialGradient(lx, ly, 4, lx, ly, r);
      glow.addColorStop(0, 'rgba(251, 191, 36, 0.22)');
      glow.addColorStop(1, 'rgba(251, 191, 36, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(lx, ly, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Minimal architectural bookshelf wall lines
    ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    drawRoundedRect(ctx, w * 0.07, h * 0.16, w * 0.48, 14, 4);
    ctx.fill();
    drawRoundedRect(ctx, w * 0.1, h * 0.34, w * 0.42, 12, 4);
    ctx.fill();
  }

  // Studio overhead key lights
  ctx.save();
  for (let i = 0; i < 4; i++) {
    const lx = w * (0.16 + i * 0.16);
    const beam = ctx.createLinearGradient(lx, 0, lx, h * 0.72);
    beam.addColorStop(0, style === 'anime' ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.06)');
    beam.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(lx - 22, 0);
    ctx.lineTo(lx + 22, 0);
    ctx.lineTo(lx + 120, h * 0.72);
    ctx.lineTo(lx - 120, h * 0.72);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawCartoonHost(
  ctx: CanvasRenderingContext2D,
  host: PermanentHost,
  centerX: number,
  baseY: number,
  scale: number,
  style: CartoonStylePreset,
  isSpeaking: boolean,
  mouthOpen: number,
  tSec: number,
  bpm: number,
  customImg: HTMLImageElement | null
) {
  const palette = HOST_PALETTES[host.id];
  const ink = style === 'lofi' ? '#1E161A' : '#090D16';
  const lineWidth = style === 'cel' ? 3.2 : 2.4;

  // Natural breathing + musical/speaking cadence
  const breathY = Math.sin(tSec * 2.1 + (host.id === 'elena' ? 0 : 1.7)) * 3.5;
  const speakBob = isSpeaking ? Math.sin(tSec * 9.5) * mouthOpen * 4.5 : 0;
  const musicSway =
    host.id === 'marcus' ? Math.sin(tSec * (bpm / 60) * Math.PI) * 3.2 : 0;
  const headTilt = isSpeaking
    ? Math.sin(tSec * 3.2) * 0.035
    : Math.sin(tSec * 1.1 + 1.2) * 0.012;

  // Periodic natural blink (~every 3.8s, unique phase per host)
  const blinkPhase = (tSec + (host.id === 'elena' ? 0.3 : host.id === 'marcus' ? 1.8 : 2.9)) % 3.9;
  const isBlinking = blinkPhase > 3.74;

  ctx.save();
  ctx.translate(centerX + musicSway, baseY + breathY + speakBob);
  ctx.scale(scale, scale);

  // Active speaker spotlight rim behind character
  if (isSpeaking) {
    const aura = ctx.createRadialGradient(0, -140, 30, 0, -140, 220);
    aura.addColorStop(0, `${palette.outfitAccent}44`);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, -140, 220, 0, Math.PI * 2);
    ctx.fill();
  }

  // If user set a custom avatar image for this host, render animated frame with voice pulse
  if (customImg && customImg.complete && customImg.naturalWidth > 0) {
    const frameW = 240;
    const frameH = 290;
    const fx = -frameW / 2;
    const fy = -305;

    ctx.save();
    ctx.rotate(headTilt * 0.6);

    // Outer broadcast avatar frame
    drawRoundedRect(ctx, fx - 6, fy - 6, frameW + 12, frameH + 12, 24);
    ctx.fillStyle = isSpeaking ? palette.outfitAccent : 'rgba(255,255,255,0.18)';
    ctx.fill();

    drawRoundedRect(ctx, fx, fy, frameW, frameH, 20);
    ctx.save();
    ctx.clip();

    const imgRatio = customImg.naturalWidth / customImg.naturalHeight;
    const boxRatio = frameW / frameH;
    let drawW = frameW;
    let drawH = frameH;
    let drawX = fx;
    let drawY = fy;
    if (imgRatio > boxRatio) {
      drawW = frameH * imgRatio;
      drawX = fx - (drawW - frameW) / 2;
    } else {
      drawH = frameW / imgRatio;
      drawY = fy - (drawH - frameH) / 2;
    }
    ctx.drawImage(customImg, drawX, drawY, drawW, drawH);

    // Voice level reactive bottom meter inside custom avatar frame
    if (isSpeaking) {
      const barCount = 9;
      for (let b = 0; b < barCount; b++) {
        const bh = 6 + mouthOpen * 28 * (0.5 + 0.5 * Math.sin(tSec * 14 + b));
        ctx.fillStyle = palette.outfitAccent;
        drawRoundedRect(ctx, -60 + b * 14, fy + frameH - 18 - bh, 8, bh, 3);
        ctx.fill();
      }
    }
    ctx.restore();

    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
    drawRoundedRect(ctx, fx, fy, frameW, frameH, 20);
    ctx.stroke();
    ctx.restore();
    ctx.restore();
    return;
  }

  // --- Torso & Blazer / Jacket ---
  ctx.save();
  ctx.fillStyle = palette.outfit;
  ctx.strokeStyle = ink;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(-115, 0);
  ctx.quadraticCurveTo(-112, -108, -42, -124);
  ctx.lineTo(42, -124);
  ctx.quadraticCurveTo(112, -108, 115, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Shirt / inner collar V
  ctx.fillStyle = palette.shirt;
  ctx.beginPath();
  ctx.moveTo(-34, -122);
  ctx.lineTo(0, -45);
  ctx.lineTo(34, -122);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Stylized lapel accent
  ctx.fillStyle = palette.outfitAccent;
  ctx.beginPath();
  ctx.moveTo(-42, -122);
  ctx.lineTo(-14, -52);
  ctx.lineTo(-36, -42);
  ctx.lineTo(-58, -92);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(42, -122);
  ctx.lineTo(14, -52);
  ctx.lineTo(36, -42);
  ctx.lineTo(58, -92);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Animated speaking hand gesture
  if (isSpeaking && mouthOpen > 0.25) {
    const handY = -36 - mouthOpen * 26;
    ctx.fillStyle = palette.skin;
    ctx.beginPath();
    ctx.ellipse(76, handY, 16, 13, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Neck
  ctx.fillStyle = palette.skinShadow;
  drawRoundedRect(ctx, -22, -155, 44, 42, 14);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // --- Head & Facial Animation ---
  ctx.save();
  ctx.translate(0, -214);
  ctx.rotate(headTilt);

  // Back hair layer for Elena & Sora
  if (host.id === 'elena') {
    ctx.fillStyle = palette.hair;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.ellipse(0, 4, 78, 86, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (host.id === 'sora') {
    ctx.fillStyle = palette.hair;
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(-74, -20);
    ctx.quadraticCurveTo(-86, 65, -62, 92);
    ctx.lineTo(62, 92);
    ctx.quadraticCurveTo(86, 65, 74, -20);
    ctx.arc(0, -16, 74, 0, Math.PI, true);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Ears
  ctx.fillStyle = palette.skinShadow;
  ctx.strokeStyle = ink;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.ellipse(-62, 4, 11, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(62, 4, 11, 16, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Face silhouette
  ctx.fillStyle = palette.skin;
  ctx.beginPath();
  ctx.moveTo(-58, -22);
  ctx.quadraticCurveTo(-60, 46, -24, 66);
  ctx.quadraticCurveTo(0, 76, 24, 66);
  ctx.quadraticCurveTo(60, 46, 58, -22);
  ctx.quadraticCurveTo(56, -78, 0, -78);
  ctx.quadraticCurveTo(-56, -78, -58, -22);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Subtle cel cheek shadow / anime blush highlight
  ctx.fillStyle = style === 'anime' ? 'rgba(244, 63, 94, 0.14)' : 'rgba(0,0,0,0.06)';
  ctx.beginPath();
  ctx.ellipse(-34, 16, 12, 7, 0, 0, Math.PI * 2);
  ctx.ellipse(34, 16, 12, 7, 0, 0, Math.PI * 2);
  ctx.fill();

  // Marcus neat beard + fade
  if (host.id === 'marcus') {
    ctx.fillStyle = palette.hair;
    ctx.beginPath();
    ctx.moveTo(-55, 8);
    ctx.quadraticCurveTo(-52, 54, -22, 68);
    ctx.quadraticCurveTo(0, 76, 22, 68);
    ctx.quadraticCurveTo(52, 54, 55, 8);
    ctx.quadraticCurveTo(40, 44, 0, 48);
    ctx.quadraticCurveTo(-40, 44, -55, 8);
    ctx.closePath();
    ctx.fill();
  }

  // Eyes + Eyebrows
  const browLift = isSpeaking ? -mouthOpen * 4.5 : 0;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  // Left eyebrow
  ctx.beginPath();
  ctx.moveTo(-36, -24 + browLift);
  ctx.quadraticCurveTo(-22, -30 + browLift, -10, -24 + browLift);
  ctx.stroke();
  // Right eyebrow
  ctx.beginPath();
  ctx.moveTo(10, -24 + browLift);
  ctx.quadraticCurveTo(22, -30 + browLift, 36, -24 + browLift);
  ctx.stroke();

  if (isBlinking) {
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(-34, -4);
    ctx.quadraticCurveTo(-22, 2, -10, -4);
    ctx.moveTo(10, -4);
    ctx.quadraticCurveTo(22, 2, 34, -4);
    ctx.stroke();
  } else {
    const eyeH = style === 'anime' ? 13 : 10;
    [-22, 22].forEach((ex) => {
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.ellipse(ex, -5, 11, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.stroke();

      // Iris
      ctx.fillStyle = palette.eyeColor;
      ctx.beginPath();
      ctx.arc(ex, -4, style === 'anime' ? 6.5 : 5.5, 0, Math.PI * 2);
      ctx.fill();

      // Specular catchlight
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(ex - 2.2, -6.5, 2.1, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Marcus round studio glasses
  if (host.id === 'marcus') {
    ctx.strokeStyle = '#D97706';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.arc(-22, -5, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(22, -5, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-6, -5);
    ctx.lineTo(6, -5);
    ctx.stroke();
  }

  // Nose
  ctx.strokeStyle = palette.skinShadow;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(-3, 14);
  ctx.lineTo(3, 16);
  ctx.stroke();

  // Animated Mouth (Audio-reactive lip sync)
  const mouthW = 14 + (isSpeaking ? mouthOpen * 8 : 0);
  const mouthH = isSpeaking ? Math.max(3, mouthOpen * 18) : 2.5;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 2.4;
  if (isSpeaking && mouthOpen > 0.16) {
    ctx.fillStyle = '#4C0D19';
    ctx.beginPath();
    ctx.ellipse(0, 34, mouthW, mouthH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Subtle upper teeth & tongue inside open cartoon mouth
    if (mouthOpen > 0.35) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(-mouthW * 0.55, 34 - mouthH + 1.5, mouthW * 1.1, Math.min(5, mouthH * 0.45));
      ctx.fillStyle = '#FB7185';
      ctx.beginPath();
      ctx.ellipse(0, 34 + mouthH * 0.45, mouthW * 0.5, mouthH * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Relaxed broadcast smile
    ctx.beginPath();
    ctx.moveTo(-12, 33);
    ctx.quadraticCurveTo(0, 38, 12, 33);
    ctx.stroke();
  }

  // Front hair styling per host
  ctx.fillStyle = palette.hair;
  ctx.strokeStyle = ink;
  ctx.lineWidth = lineWidth;
  if (host.id === 'elena') {
    ctx.beginPath();
    ctx.moveTo(-64, -22);
    ctx.quadraticCurveTo(-54, -84, 6, -86);
    ctx.quadraticCurveTo(64, -82, 64, -18);
    ctx.quadraticCurveTo(32, -48, -8, -42);
    ctx.quadraticCurveTo(-40, -36, -64, -22);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (host.id === 'marcus') {
    // Crisp high-top fade + Studio headphones
    ctx.beginPath();
    ctx.moveTo(-56, -34);
    ctx.quadraticCurveTo(-56, -86, 0, -88);
    ctx.quadraticCurveTo(56, -86, 56, -34);
    ctx.quadraticCurveTo(0, -56, -56, -34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Over-ear studio headphones
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(0, -14, 72, Math.PI * 1.04, Math.PI * 1.96);
    ctx.stroke();

    ctx.fillStyle = '#1E293B';
    ctx.strokeStyle = '#D97706';
    ctx.lineWidth = 2.4;
    drawRoundedRect(ctx, -78, -22, 18, 46, 8);
    ctx.fill();
    ctx.stroke();
    drawRoundedRect(ctx, 60, -22, 18, 46, 8);
    ctx.fill();
    ctx.stroke();
  } else {
    // Sora layered bangs + warm highlight strand
    ctx.beginPath();
    ctx.moveTo(-62, -16);
    ctx.quadraticCurveTo(-58, -86, 0, -86);
    ctx.quadraticCurveTo(58, -86, 62, -16);
    ctx.lineTo(36, -34);
    ctx.lineTo(14, -22);
    ctx.lineTo(-4, -38);
    ctx.lineTo(-28, -20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
  ctx.restore();
}

function drawBroadcastDesk(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  channel: ChannelCategory,
  style: CartoonStylePreset,
  isDualHost: boolean
) {
  const deskTopY = h * 0.72;
  const deskLeft = isDualHost ? w * 0.08 : w * 0.14;
  const deskRight = isDualHost ? w * 0.64 : w * 0.56;
  const deskW = deskRight - deskLeft;

  ctx.save();
  // Desk top surface
  ctx.fillStyle = style === 'lofi' ? '#1E1B26' : '#111827';
  ctx.strokeStyle = '#070A10';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(deskLeft, deskTopY);
  ctx.lineTo(deskRight, deskTopY);
  ctx.lineTo(deskRight + 28, h);
  ctx.lineTo(deskLeft - 28, h);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Glowing studio accent stripe along desk rim
  ctx.fillStyle =
    channel === 'news' ? '#E11D48' : channel === 'music' ? '#D97706' : '#38BDF8';
  drawRoundedRect(ctx, deskLeft + 14, deskTopY + 12, deskW - 28, 6, 3);
  ctx.fill();

  // Studio boom/desk microphone silhouette
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(deskLeft + deskW * 0.3, deskTopY + 4);
  ctx.quadraticCurveTo(deskLeft + deskW * 0.34, deskTopY - 36, deskLeft + deskW * 0.42, deskTopY - 40);
  ctx.stroke();
  ctx.fillStyle = '#1E293B';
  drawRoundedRect(ctx, deskLeft + deskW * 0.4, deskTopY - 48, 22, 14, 6);
  ctx.fill();

  // Channel studio badge on desk front
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '700 13px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillText(
    channel === 'news'
      ? 'PLEZIDO NEWS · STUDIO A'
      : channel === 'music'
        ? 'FREQUENCY & FORM · STUDIO B'
        : 'SIGNAL & CULTURE · STUDIO C',
    deskLeft + 26,
    deskTopY + 42
  );
  ctx.restore();
}

export function CartoonBroadcastStage({
  segment,
  primaryHost,
  coHost,
  activeSpeakerId,
  cameraAngle,
  audioEnabled,
  isInMusicInterlude,
  stylePreset,
  customAvatars,
  canvasRefExternal,
}: CartoonBroadcastStageProps) {
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedImagesRef = useRef<Record<string, HTMLImageElement>>({});

  // Preload custom avatar images when provided
  useEffect(() => {
    const entries = Object.entries(customAvatars) as Array<[HostId, string | undefined]>;
    for (const [hostId, url] of entries) {
      if (!url) {
        delete loadedImagesRef.current[hostId];
        continue;
      }
      const existing = loadedImagesRef.current[hostId];
      if (existing && existing.src === url) continue;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      loadedImagesRef.current[hostId] = img;
    }
  }, [customAvatars]);

  useEffect(() => {
    const canvas = internalCanvasRef.current;
    if (!canvas) return;
    if (canvasRefExternal && 'current' in canvasRefExternal) {
      (canvasRefExternal as { current: HTMLCanvasElement | null }).current = canvas;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let rafId = 0;
    const startPerf = performance.now();

    const renderFrame = (nowPerf: number) => {
      const w = canvas.width;
      const h = canvas.height;
      const tSec = prefersReducedMotion ? 0 : (nowPerf - startPerf) / 1000;

      const liveVoiceLevel = broadcastAudioEngine.getVoiceLevel();
      const spectrum = broadcastAudioEngine.getSpectrumLevels(24);

      // When muted before unmuting, synthesize gentle natural speaking cadence during dialogue beats
      const mutedCadence =
        !audioEnabled && !isInMusicInterlude
          ? Math.max(
              0.08,
              0.38 * Math.abs(Math.sin(tSec * 7.2)) + 0.22 * Math.abs(Math.sin(tSec * 12.7))
            )
          : 0;

      const activeMouth = audioEnabled
        ? Math.min(1, liveVoiceLevel * 1.45)
        : mutedCadence;

      ctx.save();

      // Dynamic camera cut framing (wide-studio | anchor-closeup | split-graphics)
      let camScale = 1;
      let camTx = 0;
      let camTy = 0;
      if (cameraAngle === 'anchor-closeup') {
        camScale = 1.12;
        camTx = -w * 0.04;
        camTy = -h * 0.02;
      } else if (cameraAngle === 'split-graphics') {
        camScale = 1.04;
        camTx = -w * 0.02;
      }
      ctx.translate(camTx, camTy);
      ctx.scale(camScale, camScale);

      drawStudioBackdrop(
        ctx,
        w,
        h,
        segment.channel,
        stylePreset,
        tSec,
        segment.musicScore.bpm,
        spectrum
      );

      const deskLineY = h * 0.725;

      if (coHost) {
        drawCartoonHost(
          ctx,
          primaryHost,
          w * 0.24,
          deskLineY,
          0.9,
          stylePreset,
          !isInMusicInterlude && activeSpeakerId === primaryHost.id,
          activeMouth,
          tSec,
          segment.musicScore.bpm,
          loadedImagesRef.current[primaryHost.id] ?? null
        );
        drawCartoonHost(
          ctx,
          coHost,
          w * 0.48,
          deskLineY,
          0.9,
          stylePreset,
          !isInMusicInterlude && activeSpeakerId === coHost.id,
          activeMouth,
          tSec,
          segment.musicScore.bpm,
          loadedImagesRef.current[coHost.id] ?? null
        );
      } else {
        drawCartoonHost(
          ctx,
          primaryHost,
          w * 0.35,
          deskLineY,
          1.06,
          stylePreset,
          !isInMusicInterlude && activeSpeakerId === primaryHost.id,
          activeMouth,
          tSec,
          segment.musicScore.bpm,
          loadedImagesRef.current[primaryHost.id] ?? null
        );
      }

      drawBroadcastDesk(ctx, w, h, segment.channel, stylePreset, Boolean(coHost));

      // Retro Lo-Fi scanline pass when lofi style is selected
      if (stylePreset === 'lofi') {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
        for (let sy = 0; sy < h; sy += 4) {
          ctx.fillRect(0, sy, w, 1);
        }
      }

      ctx.restore();
      rafId = window.requestAnimationFrame(renderFrame);
    };

    rafId = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(rafId);
  }, [
    segment.channel,
    segment.musicScore.bpm,
    primaryHost,
    coHost,
    activeSpeakerId,
    cameraAngle,
    audioEnabled,
    isInMusicInterlude,
    stylePreset,
    canvasRefExternal,
  ]);

  return (
    <canvas
      ref={internalCanvasRef}
      width={1280}
      height={720}
      aria-label={`${primaryHost.name} animated cartoon studio broadcast`}
      className="h-full w-full object-cover"
    />
  );
}
