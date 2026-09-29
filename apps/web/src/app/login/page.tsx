import { totpEnabled } from '@/lib/session';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default function LoginPage() {
  return (
    <main className="page login">
      <p className="wallet">Binance Spot wallet</p>
      <h1 className="login-title">Sign in</h1>
      <LoginForm needsCode={totpEnabled()} />
    </main>
  );
}
