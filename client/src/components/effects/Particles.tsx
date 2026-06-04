import { useEffect, useRef } from 'react'

const MOUSE_RADIUS = 150
const MOUSE_FORCE = 5
const CONNECT_DIST = 120

function drawGlowParticle(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number) {
  const glowRadius = size * 10

  const gradient = ctx.createRadialGradient(x, y, 0, x, y, glowRadius)
  gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.7})`)
  gradient.addColorStop(0.1, `rgba(255, 255, 255, ${alpha * 0.45})`)
  gradient.addColorStop(0.3, `rgba(220, 235, 255, ${alpha * 0.2})`)
  gradient.addColorStop(0.6, `rgba(200, 220, 255, ${alpha * 0.06})`)
  gradient.addColorStop(1, 'rgba(200, 220, 255, 0)')

  ctx.save()
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(x, y, glowRadius, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = '#e0eaff'
  ctx.shadowBlur = size * 8
  ctx.beginPath()
  ctx.arc(x, y, size, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = alpha * 0.95
  ctx.fillStyle = '#ffffff'
  ctx.shadowColor = '#ffffff'
  ctx.shadowBlur = size * 3
  ctx.beginPath()
  ctx.arc(x, y, size * 0.35, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/* ── White particles ── */

interface WhiteParticle {
  x: number; y: number
  vx: number; vy: number
  baseSpeed: number
  size: number; alpha: number
  pulsePhase: number; pulseSpeed: number
}

function initWhiteParticles(count: number, w: number, h: number): WhiteParticle[] {
  return Array.from({ length: count }, () => {
    const baseSpeed = Math.random() * 0.4 + 0.15
    const angle = Math.random() * Math.PI * 2
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: Math.cos(angle) * baseSpeed,
      vy: Math.sin(angle) * baseSpeed,
      baseSpeed,
      size: Math.random() * 2.5 + 1.5,
      alpha: Math.random() * 0.5 + 0.7,
      pulsePhase: Math.random() * Math.PI * 2,
      pulseSpeed: Math.random() * 0.02 + 0.01,
    }
  })
}

function drawWhite(ctx: CanvasRenderingContext2D, particles: WhiteParticle[], mouse: { x: number; y: number }, w: number, h: number) {
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x
      const dy = particles[i].y - particles[j].y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < CONNECT_DIST) {
        const lineAlpha = (1 - dist / CONNECT_DIST) * 0.2
        ctx.save()
        ctx.globalAlpha = lineAlpha
        ctx.strokeStyle = '#ffffff'
        ctx.shadowColor = '#ffffff'
        ctx.shadowBlur = 4
        ctx.lineWidth = 0.6
        ctx.beginPath()
        ctx.moveTo(particles[i].x, particles[i].y)
        ctx.lineTo(particles[j].x, particles[j].y)
        ctx.stroke()
        ctx.restore()
      }
    }
  }

  for (const p of particles) {
    const dx = p.x - mouse.x
    const dy = p.y - mouse.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist < MOUSE_RADIUS && dist > 0) {
      const force = (MOUSE_RADIUS - dist) / MOUSE_RADIUS
      p.vx += (dx / dist) * force * MOUSE_FORCE * 0.08
      p.vy += (dy / dist) * force * MOUSE_FORCE * 0.08
    }

    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
    if (speed > p.baseSpeed * 4) {
      p.vx = (p.vx / speed) * p.baseSpeed * 4
      p.vy = (p.vy / speed) * p.baseSpeed * 4
    }

    p.vx *= 0.992
    p.vy *= 0.992

    p.vx += (Math.random() - 0.5) * 0.03
    p.vy += (Math.random() - 0.5) * 0.03

    if (speed < p.baseSpeed * 0.5) {
      const angle = Math.atan2(p.vy, p.vx)
      p.vx += Math.cos(angle) * 0.02
      p.vy += Math.sin(angle) * 0.02
    }

    p.x += p.vx
    p.y += p.vy

    if (p.x < -30) p.x = w + 30
    if (p.x > w + 30) p.x = -30
    if (p.y < -30) p.y = h + 30
    if (p.y > h + 30) p.y = -30

    p.pulsePhase += p.pulseSpeed
    const pulse = 0.7 + Math.sin(p.pulsePhase) * 0.3
    const currentAlpha = p.alpha * pulse
    const currentSize = p.size * (0.85 + Math.sin(p.pulsePhase) * 0.15)

    drawGlowParticle(ctx, p.x, p.y, currentSize, currentAlpha)
  }
}

/* ── Rain ── */

interface RainDrop {
  x: number; y: number
  speed: number; length: number
  alpha: number; wind: number
}

function initRainDrops(count: number, w: number, h: number): RainDrop[] {
  return Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    speed: Math.random() * 6 + 4,
    length: Math.random() * 20 + 10,
    alpha: Math.random() * 0.3 + 0.15,
    wind: Math.random() * 0.5 + 0.3,
  }))
}

function drawRain(ctx: CanvasRenderingContext2D, drops: RainDrop[], _mouse: { x: number; y: number }, w: number, h: number) {
  for (const d of drops) {
    ctx.save()
    ctx.globalAlpha = d.alpha
    ctx.strokeStyle = '#ffffff'
    ctx.shadowColor = 'rgba(150, 180, 255, 0.3)'
    ctx.shadowBlur = 3
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(d.x, d.y)
    ctx.lineTo(d.x + d.wind * d.length * 0.3, d.y + d.length)
    ctx.stroke()
    ctx.restore()

    d.y += d.speed
    d.x += d.wind

    if (d.y > h) {
      d.y = -d.length
      d.x = Math.random() * w
    }
  }
}

/* ── Snow ── */

interface SnowFlake {
  x: number; y: number
  radius: number; speed: number
  wind: number; alpha: number
  wobblePhase: number; wobbleSpeed: number
}

function initSnowFlakes(count: number, w: number, h: number): SnowFlake[] {
  return Array.from({ length: count }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    radius: Math.random() * 3 + 1,
    speed: Math.random() * 1 + 0.3,
    wind: Math.random() * 0.5 - 0.25,
    alpha: Math.random() * 0.6 + 0.3,
    wobblePhase: Math.random() * Math.PI * 2,
    wobbleSpeed: Math.random() * 0.02 + 0.01,
  }))
}

function drawSnow(ctx: CanvasRenderingContext2D, flakes: SnowFlake[], _mouse: { x: number; y: number }, w: number, h: number) {
  for (const f of flakes) {
    f.wobblePhase += f.wobbleSpeed
    f.x += f.wind + Math.sin(f.wobblePhase) * 0.5
    f.y += f.speed

    if (f.y > h + 10) { f.y = -10; f.x = Math.random() * w }
    if (f.x > w + 10) f.x = -10
    if (f.x < -10) f.x = w + 10

    ctx.save()
    ctx.globalAlpha = f.alpha
    ctx.fillStyle = '#ffffff'
    ctx.shadowColor = '#ffffff'
    ctx.shadowBlur = f.radius * 4
    ctx.beginPath()
    ctx.arc(f.x, f.y, f.radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

/* ── Matrix ── */

interface MatrixDrop {
  x: number; y: number
  speed: number; alpha: number
  length: number; cols: number
}

const MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>{}[]|/\\'

function initMatrixDrops(count: number, _w: number, _h: number): MatrixDrop[] {
  const cols = Math.floor(_w / 18)
  return Array.from({ length: count }, () => ({
    x: Math.floor(Math.random() * cols) * 18,
    y: Math.random() * _h * -1,
    speed: Math.random() * 3 + 2,
    alpha: Math.random() * 0.5 + 0.3,
    length: Math.floor(Math.random() * 15) + 5,
    cols,
  }))
}

function drawMatrix(ctx: CanvasRenderingContext2D, drops: MatrixDrop[], _mouse: { x: number; y: number }, _w: number, h: number) {
  ctx.font = '14px JetBrains Mono, monospace'

  for (const d of drops) {
    d.y += d.speed

    if (d.y > h + d.length * 18) {
      d.y = -d.length * 18
      d.x = Math.floor(Math.random() * d.cols) * 18
    }

    for (let i = 0; i < d.length; i++) {
      const cy = d.y + i * 18
      if (cy < 0 || cy > h) continue

      const charAlpha = i === d.length - 1 ? d.alpha : d.alpha * (1 - i / d.length) * 0.7
      const char = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]

      ctx.save()
      ctx.globalAlpha = i === d.length - 1 ? charAlpha * 1.5 : charAlpha
      ctx.fillStyle = i === d.length - 1 ? '#ffffff' : '#00ff41'
      ctx.shadowColor = i === d.length - 1 ? '#ffffff' : '#00ff41'
      ctx.shadowBlur = i === d.length - 1 ? 12 : 6
      ctx.fillText(char, d.x, cy)
      ctx.restore()
    }
  }
}

/* ── Config ── */

type ParticleStyle = 'white' | 'rain' | 'snow' | 'matrix' | 'none'

interface StyleConfig {
  count: number
  init: (count: number, w: number, h: number) => any[]
  draw: (ctx: CanvasRenderingContext2D, particles: any[], mouse: { x: number; y: number }, w: number, h: number) => void
}

const STYLE_CONFIG: Record<ParticleStyle, StyleConfig | null> = {
  white: { count: 40, init: initWhiteParticles, draw: drawWhite },
  rain: { count: 150, init: initRainDrops, draw: drawRain },
  snow: { count: 100, init: initSnowFlakes, draw: drawSnow },
  matrix: { count: 40, init: initMatrixDrops, draw: drawMatrix },
  none: null,
}

interface ParticlesProps {
  fixed?: boolean
  style?: ParticleStyle
}

export default function Particles({ fixed = true, style = 'white' }: ParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<any[]>([])
  const mouseRef = useRef({ x: -9999, y: -9999 })
  const frameRef = useRef(0)

  useEffect(() => {
    const config = STYLE_CONFIG[style]
    if (!config) return

    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w: number, h: number

    const resize = () => {
      w = canvas.width = window.innerWidth
      h = canvas.height = window.innerHeight
      particlesRef.current = config.init(config.count, w, h)
    }

    resize()
    window.addEventListener('resize', resize)

    const onMouse = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX
      mouseRef.current.y = e.clientY
    }

    const onMouseLeave = () => {
      mouseRef.current.x = -9999
      mouseRef.current.y = -9999
    }

    window.addEventListener('mousemove', onMouse)
    window.addEventListener('mouseleave', onMouseLeave)

    const animate = () => {
      ctx.clearRect(0, 0, w, h)
      const particles = particlesRef.current
      const mouse = mouseRef.current
      config.draw(ctx, particles, mouse, w, h)
      frameRef.current = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      cancelAnimationFrame(frameRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [style])

  if (style === 'none') return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: fixed ? 'fixed' : 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: fixed ? 0 : 2,
      }}
    />
  )
}

export { drawGlowParticle }
