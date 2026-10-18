import { Link } from 'react-router';
import { Timeline } from '../components/Timeline.tsx';
import {
  EXAMPLE_AS_OF,
  EXAMPLE_COMPENSATION_CENTS,
  EXAMPLE_DUE_DATE,
  EXAMPLE_EVENTS,
  EXAMPLE_PRINCIPAL_CENTS,
  EXAMPLE_SEGMENTS,
} from '../content/example.ts';
import { formatDate, formatDays, formatEUR } from '../lib/format.ts';

export function Home() {
  const interest = EXAMPLE_SEGMENTS.reduce((sum, s) => sum + s.interest, 0);
  const overdueDays = EXAMPLE_SEGMENTS.reduce((sum, s) => sum + s.days, 0);
  const total = EXAMPLE_PRINCIPAL_CENTS + interest + EXAMPLE_COMPENSATION_CENTS;

  return (
    <div className="wrap hero">
      <title>
        Reclama · Cobra tus facturas vencidas con los intereses de la ley
      </title>
      <div className="hero-top">
        <h1>Cobra lo que te deben, con los intereses que marca la ley.</h1>
        <div className="hero-copy">
          <p>
            Importa tus facturas vencidas, calcula la demora al céntimo con los
            tipos del BOE y descarga el requerimiento de pago en PDF.
          </p>
          <div className="cta">
            <Link className="btn primary" to="/demo">
              Probar la demo
            </Link>
            <Link className="btn" to="/registro">
              Crear cuenta
            </Link>
            <small>La demo no pide registro y usa datos ficticios.</small>
          </div>
        </div>
      </div>

      <section className="sheet" aria-labelledby="ej-title">
        <div className="sheet-head">
          <h2 id="ej-title">
            Así se calcula una factura de {formatEUR(EXAMPLE_PRINCIPAL_CENTS)}{' '}
            vencida hace {formatDays(overdueDays)}
          </h2>
          <p>
            Tipos de demora publicados en el BOE, un tramo por semestre. Ejemplo
            ficticio calculado a {formatDate(EXAMPLE_AS_OF)}.
          </p>
        </div>
        <Timeline
          due={EXAMPLE_DUE_DATE}
          today={EXAMPLE_AS_OF}
          segments={EXAMPLE_SEGMENTS}
          events={EXAMPLE_EVENTS}
        />
        <dl className="totals">
          <div>
            <dt>Principal</dt>
            <dd className="amt">{formatEUR(EXAMPLE_PRINCIPAL_CENTS)}</dd>
          </div>
          <div>
            <dt>Intereses de demora</dt>
            <dd className="amt">{formatEUR(interest)}</dd>
          </div>
          <div>
            <dt>Compensación por costes de cobro</dt>
            <dd className="amt">{formatEUR(EXAMPLE_COMPENSATION_CENTS)}</dd>
          </div>
          <div className="grand">
            <dt>Total a reclamar</dt>
            <dd className="amt">{formatEUR(total)}</dd>
          </div>
        </dl>
      </section>

      <ol className="steps" aria-label="Cómo funciona">
        <li>
          <b>Importa tus facturas</b>
          <span>Sube el CSV que exporta tu programa de facturación.</span>
        </li>
        <li>
          <b>Revisa los intereses</b>
          <span>Cada factura muestra su desglose por semestre.</span>
        </li>
        <li>
          <b>Reclama</b>
          <span>Descarga el requerimiento y sigue la guía de escalado.</span>
        </li>
      </ol>
    </div>
  );
}
