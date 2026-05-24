import { useState } from 'react'
import { api } from '../lib/api'

export function Login({ onAuthed }: { onAuthed: (u: any) => void }) {
  const [mode, setMode] = useState<'login' | 'bootstrap'>('login')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null); setBusy(true)
    try {
      const fn = mode === 'login' ? api.login(email, password) : api.bootstrap(email, password, displayName)
      const { token, user } = await fn
      api.setToken(token)
      onAuthed(user)
    } catch (e: any) {
      setErr(e.message)
      // On "users already exist" the bootstrap flow should just offer login.
      if (mode === 'bootstrap' && /already exist/i.test(e.message)) setMode('login')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Sign in to vyos-cp' : 'Create first admin user'}</h1>
        {err && <div className="err">{err}</div>}
        {mode === 'bootstrap' && (
          <div className="field">
            <label>Display name</label>
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)} required />
          </div>
        )}
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <button type="button" className="btn"
            style={{ background: 'transparent', border: 0, color: 'var(--brand)', padding: 0 }}
            onClick={() => setMode(m => m === 'login' ? 'bootstrap' : 'login')}>
            {mode === 'login' ? 'First-time setup →' : '← Back to sign in'}
          </button>
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create admin'}
          </button>
        </div>
        {mode === 'bootstrap' && (
          <p className="hint" style={{ marginTop: 12 }}>
            Bootstrap only works on a fresh install. Uses POST /api/v1/auth/bootstrap.
          </p>
        )}
      </form>
    </div>
  )
}
