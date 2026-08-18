import axios from 'axios'
import { useAuthStore } from '../store'

const api = axios.create({
  baseURL: '/api',
  withCredentials: true,
  // No default timeout meant a server-side stall (exchange rate-limit wait,
  // hung Redis) left the promise pending forever — and the in-flight request
  // caches in candle-prefetch would then serve that dead promise to every
  // later attempt, freezing charts until a page reload. 15s bounds the damage.
  timeout: 15000,
})

api.interceptors.response.use(null, (error) => {
  if (error.response?.status === 401) {
    useAuthStore.getState().logout()
  }
  return Promise.reject(error)
})

export default api
