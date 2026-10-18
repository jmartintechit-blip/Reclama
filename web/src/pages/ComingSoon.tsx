import { Link } from 'react-router';

// Placeholder for the screens that are not built yet. Their routes already exist, so building a
// screen means replacing the element of its route and nothing else.
export function ComingSoon({ screen }: { screen: string }) {
  return (
    <div className="wrap prose">
      <title>Próximamente · Reclama</title>
      <h1>Próximamente</h1>
      <p>
        La pantalla «{screen}» todavía no está disponible. Llegará pronto.
        Mientras tanto, puedes ver cómo se calcula una factura en la portada.
      </p>
      <p>
        <Link className="btn primary" to="/">
          Volver a la portada
        </Link>
      </p>
    </div>
  );
}
