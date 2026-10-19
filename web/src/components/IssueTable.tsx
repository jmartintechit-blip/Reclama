import { useState } from 'react';
import type { ImportRowIssue } from '../lib/api-types.ts';
import { describeRowIssue, fieldName } from '../lib/csv-upload.ts';
import { formatCount } from '../lib/format.ts';

// A file can have hundreds of problems; the first ones are what matters to fix the file, and
// the rest is one button away.
export const VISIBLE_ISSUES = 50;

// Row errors or warnings of an import: one table, row by row, in Spanish.
export function IssueTable({
  title,
  note,
  issues,
}: {
  title: string;
  note: string;
  issues: ImportRowIssue[];
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? issues : issues.slice(0, VISIBLE_ISSUES);
  const capped = issues.length > VISIBLE_ISSUES;

  return (
    <div className="card">
      <div className="table-wrapper">
        <table>
          <caption>
            {title}
            <small>{note}</small>
            {capped ? (
              <small>
                Se muestran {formatCount(shown.length)} de{' '}
                {formatCount(issues.length)}.
              </small>
            ) : null}
          </caption>
          <thead>
            <tr>
              <th scope="col">Fila</th>
              <th scope="col">Campo</th>
              <th scope="col">Problema</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((issue, index) => (
              // The same row can have several issues, so the row number alone is not a key.
              <tr key={`${String(issue.row)}-${issue.code}-${String(index)}`}>
                <th scope="row" data-label="Fila">
                  {issue.row}
                </th>
                <td data-label="Campo">{fieldName(issue.field)}</td>
                <td data-label="Problema">{describeRowIssue(issue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {capped ? (
        <div className="table-more">
          <button
            type="button"
            className="btn small"
            aria-expanded={showAll}
            onClick={() => {
              setShowAll((value) => !value);
            }}
          >
            {showAll
              ? `Mostrar solo los primeros ${String(VISIBLE_ISSUES)}`
              : `Mostrar todos (${formatCount(issues.length)})`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
