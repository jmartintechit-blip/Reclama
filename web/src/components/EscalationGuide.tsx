import { useId, useRef, useState } from 'react';
import type { ActionGuide, ClaimDetail } from '../lib/api-types.ts';
import {
  fillTemplate,
  MISSING_VALUE_LABELS,
  TEMPLATE_GAP,
  templateValues,
} from '../lib/claims.ts';
import { formatDate } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

type CopyState = 'idle' | 'copied' | 'failed';

// The template of the guide with its placeholders filled in the browser. The text is read-only
// (it is a model to copy and adapt in the person's own mail), and what could not be filled is
// left as a visible gap with a note instead of an invented value.
function GuideTemplate({
  claim,
  template,
  today,
}: {
  claim: ClaimDetail;
  template: NonNullable<ActionGuide['template']>;
  today: string;
}) {
  const { profile } = useSession();
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [copy, setCopy] = useState<CopyState>('idle');
  const filled = fillTemplate(
    template.text,
    templateValues(claim, profile?.business_name, today),
  );

  async function copyText() {
    try {
      await navigator.clipboard.writeText(filled.text);
      setCopy('copied');
    } catch {
      // No permission or no clipboard (an insecure page): select the text so Ctrl+C works.
      area.current?.select();
      setCopy('failed');
    }
  }

  return (
    <div className="template">
      <h4 id={`${id}-title`}>Texto para copiar</h4>
      <textarea
        ref={area}
        className="input"
        readOnly
        rows={Math.min(filled.text.split('\n').length + 1, 20)}
        aria-labelledby={`${id}-title`}
        aria-describedby={
          filled.missing.length > 0 ? `${id}-missing` : undefined
        }
        value={filled.text}
      />
      {filled.missing.length > 0 ? (
        <p id={`${id}-missing`} className="note">
          Donde ves {TEMPLATE_GAP} falta un dato que no podemos inventar:{' '}
          {filled.missing
            .map((name) => MISSING_VALUE_LABELS[name] ?? name)
            .join('; ')}
          . Complétalo a mano antes de enviar el texto.
        </p>
      ) : null}
      <div className="actions claim">
        <button
          type="button"
          className="btn"
          onClick={() => {
            void copyText();
          }}
        >
          Copiar texto
        </button>
        <p role="status" className="note">
          {copy === 'copied'
            ? 'Texto copiado.'
            : copy === 'failed'
              ? 'No hemos podido copiar, selecciónalo a mano.'
              : ''}
        </p>
      </div>
    </div>
  );
}

function GuideList({
  title,
  items,
  ordered = false,
}: {
  title: string;
  items: readonly string[];
  ordered?: boolean;
}) {
  const id = useId();
  if (items.length === 0) return null;
  const List = ordered ? 'ol' : 'ul';
  return (
    <div>
      <h4 id={id}>{title}</h4>
      <List className="guide-list" aria-labelledby={id}>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </List>
    </div>
  );
}

// The next step of the claim, as the server decided it: its reason, the warnings and the guide.
// Nothing legal is written here: every text of this section comes from the API.
export function EscalationGuide({
  claim,
  today,
}: {
  claim: ClaimDetail;
  today: string;
}) {
  const { reason, earliest_on, warnings, guide, action } = claim.next_action;
  return (
    <section className="panel" aria-labelledby="siguiente-titulo">
      <h2 id="siguiente-titulo">Siguiente paso</h2>
      <h3>{guide.title}</h3>
      <p>{reason}</p>
      {earliest_on === null ? null : (
        <p className="note">Sugerido a partir del {formatDate(earliest_on)}.</p>
      )}
      {warnings.map((warning) => (
        <div key={warning.code} className="notice" role="note">
          <p>
            <b>Aviso:</b> {warning.message}
          </p>
        </div>
      ))}
      <p>{guide.why}</p>
      <GuideList title="Qué hacer" items={guide.steps} ordered />
      <GuideList title="Qué necesitas tener a mano" items={guide.prepare} />
      <GuideList title="Qué puede pasar después" items={guide.outcomes} />
      <GuideList title="Ten en cuenta" items={guide.notes} />
      {guide.template === null ? null : (
        <GuideTemplate
          // A new step is a new template: the "copied" message must not carry over.
          key={action}
          claim={claim}
          template={guide.template}
          today={today}
        />
      )}
    </section>
  );
}
