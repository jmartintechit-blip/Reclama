import { describe, expect, it } from 'vitest';
import type { NextActionKind } from './escalation.ts';
import {
  ESCALATION_GUIDE,
  PLACEHOLDERS,
  placeholdersOf,
  renderTemplate,
  type ActionGuide,
  type Placeholder,
} from './escalation-guide.ts';

const ACTIONS: NextActionKind[] = [
  'SEND_REMINDER',
  'SEND_DEMAND',
  'SEND_BUROFAX',
  'FILE_MONITORIO',
  'DONE',
  'BLOCKED',
];
const WITH_TEMPLATE: NextActionKind[] = [
  'SEND_REMINDER',
  'SEND_DEMAND',
  'SEND_BUROFAX',
];

const guideOf = (action: NextActionKind): ActionGuide =>
  ESCALATION_GUIDE[action];

// Every text of the guide, with the template texts apart (they are the only ones with line breaks).
function allTexts(): { where: string; text: string; multiline: boolean }[] {
  return ACTIONS.flatMap((action) => {
    const g = guideOf(action);
    const lists = {
      steps: g.steps,
      prepare: g.prepare,
      outcomes: g.outcomes,
      notes: g.notes,
    };
    return [
      { where: `${action}.title`, text: g.title, multiline: false },
      { where: `${action}.why`, text: g.why, multiline: false },
      ...Object.entries(lists).flatMap(([name, list]) =>
        list.map((text, i) => ({
          where: `${action}.${name}[${String(i)}]`,
          text,
          multiline: false,
        })),
      ),
      ...(g.template === null
        ? []
        : [
            {
              where: `${action}.template`,
              text: g.template.text,
              multiline: true,
            },
          ]),
    ];
  });
}

describe('ESCALATION_GUIDE', () => {
  it('has content for every action and nothing else', () => {
    expect(Object.keys(ESCALATION_GUIDE).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) {
      const g = guideOf(action);
      expect(g.title.trim(), action).not.toBe('');
      expect(g.why.trim(), action).not.toBe('');
      expect(g.steps.length, action).toBeGreaterThan(0);
    }
  });

  it('gives a template to the three steps that send a text, and to no other', () => {
    for (const action of ACTIONS) {
      expect(guideOf(action).template !== null, action).toBe(
        WITH_TEMPLATE.includes(action),
      );
    }
  });

  it('declares the placeholders each template uses, once each, in order of appearance', () => {
    for (const action of WITH_TEMPLATE) {
      const template = guideOf(action).template;
      expect(template, action).not.toBeNull();
      expect(template?.placeholders, action).toEqual(
        placeholdersOf(template?.text ?? ''),
      );
      expect(template?.placeholders.length, action).toBeGreaterThan(0);
    }
  });

  it('only uses the allowed placeholders', () => {
    for (const action of WITH_TEMPLATE) {
      for (const name of guideOf(action).template?.placeholders ?? []) {
        expect(PLACEHOLDERS, action).toContain(name);
      }
    }
  });

  it('renders every template with sample values and leaves no placeholder behind', () => {
    const values = Object.fromEntries(
      PLACEHOLDERS.map((name) => [name, `<${name}>`]),
    ) as Record<Placeholder, string>;

    for (const action of WITH_TEMPLATE) {
      const text = renderTemplate(guideOf(action).template?.text ?? '', values);
      expect(text, action).not.toMatch(/\{\{|\}\}/);
    }
    const demand = renderTemplate(
      guideOf('SEND_DEMAND').template?.text ?? '',
      values,
    );
    expect(demand).toContain('<invoice_numbers>');
    expect(demand).toContain('<deadline>');
  });

  it('has no control or invisible formatting characters (line breaks only in the templates)', () => {
    for (const { where, text, multiline } of allTexts()) {
      const checked = multiline ? text.replace(/\n/g, '') : text;
      expect(checked, where).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
  });

  // A figure written into a text goes stale: amounts and rates come from the claim.
  const STALE_FIGURE = /\d[\d.,]*\s*(?:€|eur\b|euros?\b|%)|%|por ciento/i;

  it('the stale-figure check catches amounts and percentages', () => {
    for (const bad of [
      '40 €',
      '40 euros',
      '1.000,00 EUR',
      '10,40 %',
      '10%',
      'el 5 por ciento',
    ]) {
      expect(bad).toMatch(STALE_FIGURE);
    }
    expect('Ley 3/2004, art. 815, veinte días').not.toMatch(STALE_FIGURE);
  });

  it('has no hard-coded euro amounts or percentages', () => {
    for (const { where, text } of allTexts()) {
      expect(text, where).not.toMatch(STALE_FIGURE);
    }
  });

  it('the monitorio guide says it is not the app that files it, and tells the user to consider a lawyer', () => {
    const g = guideOf('FILE_MONITORIO');

    expect(g.template).toBeNull();
    expect(g.notes.join(' ')).toContain('Valora consultar a un abogado');
    expect(g.steps.join(' ')).toContain('Reclama no presenta nada');
    expect(g.outcomes.length).toBe(5); // admission, reduction proposal, pays, opposes, silence
  });

  it('the burofax guide says the app never sends one', () => {
    expect(guideOf('SEND_BUROFAX').notes.join(' ')).toContain(
      'Reclama no envía burofaxes',
    );
  });

  it('the guide of a blocked claim does not call the public administration outside the law', () => {
    const text = [guideOf('BLOCKED').why, ...guideOf('BLOCKED').steps].join(
      ' ',
    );

    expect(text).not.toMatch(/fuera de la Ley/);
  });
});

describe('placeholdersOf and renderTemplate', () => {
  it('substitutes every occurrence', () => {
    expect(
      renderTemplate(
        '{{debtor_name}} debe {{total}}. Gracias, {{debtor_name}}.',
        {
          debtor_name: 'Acme S.L.',
          total: '10,00 €',
        },
      ),
    ).toBe('Acme S.L. debe 10,00 €. Gracias, Acme S.L..');
  });

  it('lists each placeholder once, in order of first appearance', () => {
    expect(placeholdersOf('{{total}} {{debtor_name}} {{total}}')).toEqual([
      'total',
      'debtor_name',
    ]);
    expect(placeholdersOf('no placeholders')).toEqual([]);
  });

  it('refuses an unknown placeholder, also in other letter cases or with spaces', () => {
    for (const text of [
      '{{iban}}',
      '{{Total}}',
      '{{ total }}',
      '{{}}',
      '{{debtor-name}}',
    ]) {
      expect(() => renderTemplate(text, { total: 'x' }), text).toThrow(
        /Unknown placeholder/,
      );
      expect(() => placeholdersOf(text), text).toThrow(/Unknown placeholder/);
    }
  });

  it('refuses a brace that is not part of a well-formed placeholder', () => {
    for (const text of ['{{total', 'total}}', '{{ {{total}}']) {
      expect(() => renderTemplate(text, { total: 'x' }), text).toThrow(
        /unbalanced/,
      );
    }
  });

  it('refuses a known placeholder without a value, so a letter never leaves with a hole', () => {
    expect(() => renderTemplate('{{total}}', {})).toThrow(
      /No value for \{\{total\}\}/,
    );
    expect(renderTemplate('{{total}}', { total: '' })).toBe('');
  });

  it('does not expand a placeholder that is inside a value', () => {
    expect(
      renderTemplate('{{debtor_name}} {{total}}', {
        debtor_name: '{{total}}',
        total: '5',
      }),
    ).toBe('{{total}} 5');
  });
});
