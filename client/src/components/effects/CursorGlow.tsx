import { useEffect, useRef } from 'react'

const TRAIL_LENGTH = 16

interface TrailPoint {
  x: number
  y: number
}

export default function CursorGlow() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mouseRef = useRef({ x: -200, y: -200 })
  const trailRef = useRef<TrailPoint[]>([])
  const frameRef = useRef(0)
  const visibleRef = useRef(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let w: number, h: number
    const resize = () => {
      w = canvas.width = window.innerWidth
      h = canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    for (let i = 0; i < TRAIL_LENGTH + 1; i++) {
      trailRef.current.push({ x: -200, y: -200 })
    }

    const onMouse = (e: MouseEvent) => {
      mouseRef.current.x = e.clientX
      mouseRef.current.y = e.clientY
      visibleRef.current = true
    }

    const onMouseLeave = () => {
      visibleRef.current = false
    }

    window.addEventListener('mousemove', onMouse)
    window.addEventListener('mouseleave', onMouseLeave)

    const drawParticle = (x: number, y: number, size: number, alpha: number) => {
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

    const animate = () => {
      ctx.clearRect(0, 0, w, h)

      const mouse = mouseRef.current
      const trail = trailRef.current

      trail[0].x += (mouse.x - trail[0].x) * 0.22
      trail[0].y += (mouse.y - trail[0].y) * 0.22

      for (let i = 1; i < trail.length; i++) {
        const lag = 0.2 - i * 0.006
        trail[i].x += (trail[i - 1].x - trail[i].x) * Math.max(lag, 0.06)
        trail[i].y += (trail[i - 1].y - trail[i].y) * Math.max(lag, 0.06)
      }

      if (visibleRef.current) {
        for (let i = trail.length - 1; i >= 0; i--) {
          const t = 1 - i / trail.length
          const alpha = t * 0.55
          const size = 1.2 + t * 1.8
          drawParticle(trail[i].x, trail[i].y, size, alpha)
        }

        drawParticle(mouse.x, mouse.y, 3, 0.95)
      }

      frameRef.current = requestAnimationFrame(animate)
    }

    animate()

    return () => {
      cancelAnimationFrame(frameRef.current)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouse)
      window.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  )
}
