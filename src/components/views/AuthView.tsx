'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/store/auth';
import { useRouter } from '@/lib/store/router';

export function AuthView() {
  const authMode = useRouter((s) => s.authMode);
  const navigate = useRouter((s) => s.navigate);
  const { login, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (authMode === 'signup') {
        await register(email, password, name || email.split('@')[0]);
      } else {
        await login(email, password);
      }
      navigate('dashboard');
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <button className="flex items-center gap-2 mb-2 text-left" onClick={() => navigate('landing')}>
            { }
            <img src="/logo.svg" alt="" className="w-7 h-7" />
            <span className="font-semibold">LocalForge IDE</span>
          </button>
          <CardTitle>{authMode === 'signup' ? 'Create your account' : 'Sign in'}</CardTitle>
          <CardDescription>
            {authMode === 'signup'
              ? 'Accounts manage subscriptions and project metadata. Your code and models stay local.'
              : 'Welcome back. Your account syncs project metadata — never source code.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {authMode === 'signup' && (
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete={authMode === 'signup' ? 'new-password' : 'current-password'} />
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? 'Working…' : authMode === 'signup' ? 'Create account' : 'Sign in'}
            </Button>
          </form>
          <p className="mt-4 text-sm text-muted-foreground text-center">
            {authMode === 'signup' ? (
              <>Already have an account? <button className="text-primary hover:underline" onClick={() => navigate('auth', { authMode: 'login' })}>Sign in</button></>
            ) : (
              <>New here? <button className="text-primary hover:underline" onClick={() => navigate('auth', { authMode: 'signup' })}>Create an account</button></>
            )}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
