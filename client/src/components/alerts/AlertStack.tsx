import { useState, useMemo } from 'react'
import { useAlertStore, useAuthStore, useCoinListStore } from '../../store'
import api from '../../services/api'
import { formatPrice, extractBaseAsset } from '../../utils/format'
import { Bell, TrendingUp, List, BellOff, X, Plus } from 'lucide-react'

const ALERT_STYLES: Record<string, { bg: string; border: string; text: string; label: string; icon: any }> = {
  price: { bg: 'bg-[#3b82f6]/12', border: 'border-[#3b82f6]/30', text: 'text-[#3b82f6]', label: 'Пересечение цены', icon: Bell },
  listing: { bg: 'bg-[#26a65b]/12', border: 'border-[#26a65b]/30', text: 'text-[#26a65b]', label: 'Листинг', icon: List },
  impulse: { bg: 'bg-[#f59e0b]/12', border: 'border-[#f59e0b]/30', text: 'text-[#f59e0b]', label: 'Импульс', icon: TrendingUp },
}

function CreateAlertForm({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState<'price' | 'impulse'>('price')
  const [symbol, setSymbol] = useState('')
  const [price, setPrice] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [percent, setPercent] = useState('5')
  const { isLoggedIn } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isLoggedIn) return
    const condition = type === 'price'
      ? { price: parseFloat(price), direction }
      : { percent: parseFloat(percent), within: '5m' }

    await api.post('/alerts', { type, symbol: symbol.toUpperCase() || 'ANY', condition })
    onClose()
  }

  if (!isLoggedIn) {
    return (
      <div className="p-3 bg-[#141414] border border-[#1f1f1f] rounded-lg text-center">
        <p className="text-[11px] text-[#888]">Авторизуйтесь для создания алертов</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="p-3 bg-[#141414] border border-[#1f1f1f] rounded-lg space-y-2">
      <div className="flex gap-1">
        <button
          type="button"
          className={`clinic-btn clinic-btn-sm text-[10px] px-2 py-1 ${
            type === 'price' ? 'clinic-btn-active' : 'clinic-btn-secondary'
          }`}
          onClick={() => setType('price')}
        >
          Цена
        </button>
        <button
          type="button"
          className={`clinic-btn clinic-btn-sm text-[10px] px-2 py-1 ${
            type === 'impulse' ? 'clinic-btn-active' : 'clinic-btn-secondary'
          }`}
          onClick={() => setType('impulse')}
        >
          Импульс
        </button>
      </div>
      <input
        className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-[#e5e5e5] text-[11px] outline-none focus:border-[#555]"
        placeholder="Тикер (например BTCUSDT)"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
      />
      {type === 'price' ? (
        <div className="flex gap-1">
          <input
            className="flex-1 bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-[#e5e5e5] text-[11px] outline-none focus:border-[#555]"
            placeholder="Цена"
            type="number"
            step="any"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <select
            className="bg-[#0a0a0a] border border-[#2a2a2a] rounded px-1 py-1.5 text-[#e5e5e5] text-[11px] outline-none"
            value={direction}
            onChange={(e) => setDirection(e.target.value as any)}
          >
            <option value="above">Выше</option>
            <option value="below">Ниже</option>
          </select>
        </div>
      ) : (
        <input
          className="w-full bg-[#0a0a0a] border border-[#2a2a2a] rounded px-2 py-1.5 text-[#e5e5e5] text-[11px] outline-none focus:border-[#555]"
          placeholder="% изменения"
          type="number"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      )}
      <div className="flex gap-1 justify-end pt-1">
        <button type="button" className="clinic-btn clinic-btn-secondary clinic-btn-sm text-[10px] px-2 py-1" onClick={onClose}>Отмена</button>
        <button type="submit" className="clinic-btn clinic-btn-sm text-[10px] px-3 py-1 clinic-btn-exchange-active">Создать</button>
      </div>
    </form>
  )
}

export function AlertStack() {
  const { alerts, dismissAlert, muteAlert } = useAlertStore()
  const coinMap = useCoinListStore(s => s.coinMap)
  const [showForm, setShowForm] = useState(false)

  const grouped = useMemo(() => alerts.reduce((acc: any, alert: any) => {
    const type = alert.type || 'price'
    if (!acc[type]) acc[type] = []
    acc[type].push(alert)
    return acc
  }, {}), [alerts])

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="flex items-center justify-between px-3 py-2 bg-[#0e0e0e] border-b border-[#1f1f1f] flex-shrink-0">
        <span className="text-[11px] font-bold text-white">Уведомления</span>
        <button
          className="clinic-btn clinic-btn-sm clinic-btn-exchange-active flex items-center gap-1 text-[10px] px-2 py-1"
          onClick={() => setShowForm(true)}
        >
          <Plus size={12} />
          Новый
        </button>
      </div>

      {showForm && (
        <div className="p-2 border-b border-[#1f1f1f] flex-shrink-0">
          <CreateAlertForm onClose={() => setShowForm(false)} />
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {alerts.length === 0 && !showForm && (
          <div className="text-center py-8 text-[#333] text-[11px]">Нет уведомлений</div>
        )}

        {alerts.map((alert: any) => {
          const style = ALERT_STYLES[alert.type] || ALERT_STYLES.price
          const count = grouped[alert.type]?.length || 1

          return (
            <div
              key={alert.id}
              className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-colors hover:bg-white/[0.02] cursor-pointer ${style.bg} ${style.border}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${style.bg} ${style.border} ${style.text}`}>
                    {style.label}
                  </span>
                  <span className="text-[10px] text-[#888]">{new Date(alert.triggeredAt || Date.now()).toLocaleTimeString('ru-RU')}</span>
                </div>
                <div className="font-mono font-bold text-[13px] text-white">
                  {extractBaseAsset(alert.symbol) || 'ANY'}
                </div>
                <div className="text-[11px] text-[#888]">
                  {alert.type === 'price' && (
                    <span>Цена: <span className="text-[#e5e5e5]">${formatPrice(alert.price, coinMap.get(alert.symbol)?.pricePrecision ?? 2)}</span></span>
                  )}
                  {alert.type === 'impulse' && (
                    <span className={style.text}>{alert.condition?.percent}% движение</span>
                  )}
                  {alert.exchange && <span className="ml-2 text-[#555]">{alert.exchange}</span>}
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                <span className="w-5 h-5 rounded-full bg-[#2a2a2a] text-[#aaa] text-[10px] flex items-center justify-center font-mono">
                  {count}
                </span>
                <button
                  className="clinic-btn clinic-btn-ghost p-1"
                  onClick={(e) => { e.stopPropagation(); muteAlert(alert.id) }}
                >
                  <BellOff size={12} />
                </button>
                <button
                  className="clinic-btn clinic-btn-danger p-1"
                  onClick={(e) => { e.stopPropagation(); dismissAlert(alert.id) }}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
