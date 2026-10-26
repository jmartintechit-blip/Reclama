import { Link } from 'react-router';

export function NotFound() {
  return (
    <div className="wrap prose">
      <title>Página no encontrada · Reclama</title>
      {/* The host answers 200 for every path, so say it explicitly: this is not a page to index. */}
      <meta name="robots" content="noindex" />
      <h1>No encontramos esta página</h1>
      <p>
        La dirección no existe o ha cambiado. Puedes volver a la portada y
        empezar desde ahí.
      </p>
      <p>
        <Link className="btn primary" to="/">
          Volver a la portada
        </Link>
      </p>
    </div>
  );
}
