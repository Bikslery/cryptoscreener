import { useState } from 'react'
import api from '../../services/api'
import { useAuthStore, useUIStore } from '../../store'

export function LoginModal() {
  const [isRegister, setIsRegister] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login } = useAuthStore()
  const { setShowLogin } = useUIStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      const endpoint = isRegister ? '/auth/register' : '/auth/login'
      const res = await api.post(endpoint, { email, password })
      login(res.data.token, res.data.user.email)
      setShowLogin(false)
    } catch (err: any) {
      setError(err.response?.data?.error || 'Ошибка авторизации')
    }
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowLogin(false)}>
      <div
        className="w-full max-w-sm p-6 bg-[#0e0e0e] border border-[#1f1f1f] rounded-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h1 className="text-lg font-bold text-center mb-6 text-white" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
          {isRegister ? 'Регистрация' : 'Вход'}
        </h1>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 bg-[#141414] border border-[#2a2a2a] rounded-lg text-[#e5e5e5] text-sm outline-none focus:border-[#555] transition-colors"
            required
          />
          <input
            type="password"
            placeholder="Пароль"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 bg-[#141414] border border-[#2a2a2a] rounded-lg text-[#e5e5e5] text-sm outline-none focus:border-[#555] transition-colors"
            required
          />
          {error && <div className="text-sm text-[#e74c3c]">{error}</div>}
          <button
            type="submit"
            className="w-full py-2 bg-white text-black rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity"
          >
            {isRegister ? 'Зарегистрироваться' : 'Войти'}
          </button>
          <button
            type="button"
            className="w-full py-1 text-sm text-[#666] hover:text-[#aaa] transition-colors"
            onClick={() => { setIsRegister(!isRegister); setError('') }}
          >
            {isRegister ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться'}
          </button>
        </form>
      </div>
    </div>
  )
}
