import { useAuthStore, useUIStore } from '../../store'
import { X, User, LogOut, Shield } from 'lucide-react'
import './ProfileModal.css'

export default function ProfileModal() {
  const { username, telegramVerified, logout } = useAuthStore()
  const { setShowProfile } = useUIStore()

  const handleLogout = async () => {
    await logout()
    setShowProfile(false)
  }

  return (
    <div className="profile-overlay" onClick={() => setShowProfile(false)}>
      <div className="profile-backdrop" />
      <div className="profile-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="profile-header">
          <div className="profile-avatar">
            {username?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="profile-header-info">
            <div className="profile-name">{username}</div>
            <div className="profile-role">пользователь</div>
          </div>
          <button className="profile-close" onClick={() => setShowProfile(false)}>
            <X size={14} />
          </button>
        </div>

        {/* Account section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <User size={14} />
            </div>
            <h2>Аккаунт</h2>
          </div>

          <div className="profile-field">
            <label>Логин</label>
            <span className="field-value">{username}</span>
          </div>

          <div className="profile-field">
            <label>Telegram</label>
            <span className={`profile-badge ${telegramVerified ? 'verified' : 'unverified'}`}>
              <span className="profile-badge-dot" />
              {telegramVerified ? 'привязан' : 'не привязан'}
            </span>
          </div>
        </div>

        {/* Actions section */}
        <div className="profile-section">
          <div className="section-header">
            <div className="section-icon">
              <Shield size={14} />
            </div>
            <h2>Действия</h2>
          </div>

          <button className="profile-logout-btn" onClick={handleLogout}>
            <LogOut size={15} />
            выйти
          </button>
        </div>
      </div>
    </div>
  )
}
