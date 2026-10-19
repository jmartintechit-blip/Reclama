import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Failure } from '../lib/api.ts';
import { failureMessage } from '../lib/messages.ts';

// The page shell of the claim screens: title, optional way back and the content.
export function ClaimFrame({
  title,
  back,
  children,
}: {
  title: string;
  back?: { to: string; label: string };
  children: ReactNode;
}) {
  return (
    <div className="wrap panel-page">
      <title>{title}</title>
      {back ? (
        <Link className="back" to={back.to}>
          <span aria-hidden="true">←</span> {back.label}
        </Link>
      ) : null}
      {children}
    </div>
  );
}

export function ClaimLoading({ label }: { label: string }) {
  return (
    <div className="card state" role="status">
      <span className="sr-only">{label}</span>
      <div className="skeleton" style={{ inlineSize: '40%' }} aria-hidden />
      <div className="skeleton" aria-hidden />
      <div className="skeleton" style={{ inlineSize: '85%' }} aria-hidden />
    </div>
  );
}

export function ClaimLoadError({
  heading,
  level = 1,
  failure,
  retrying,
  onRetry,
}: {
  heading: string;
  // 2 when the page already has its own h1.
  level?: 1 | 2;
  failure: Failure;
  retrying: boolean;
  onRetry: () => void;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <div className="card state error" role="alert">
      <Heading>{heading}</Heading>
      <p>{failureMessage(failure)}</p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={retrying}
          onClick={onRetry}
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
