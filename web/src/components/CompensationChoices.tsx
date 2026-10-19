import { useId } from 'react';
import type { Compensation } from '../lib/session.tsx';

export const COMPENSATION_OPTIONS: {
  value: Compensation;
  title: string;
  text: string;
}[] = [
  {
    value: 'NONE',
    title: 'Sin compensación',
    text: 'No sumas nada por los costes de cobro: solo el principal y los intereses.',
  },
  {
    value: 'PER_INVOICE',
    title: '40 € por factura vencida',
    text: 'Se suman 40 € por cada factura vencida de la reclamación. Es la lectura más favorable para ti.',
  },
  {
    value: 'PER_CLAIM',
    title: '40 € por reclamación (la lectura más prudente)',
    text: 'Se suman 40 € una sola vez por reclamación, tenga una factura o varias.',
  },
];

export function CompensationOption({
  name,
  option,
  checked,
  onSelect,
}: {
  name: string;
  option: (typeof COMPENSATION_OPTIONS)[number];
  checked: boolean;
  onSelect: () => void;
}) {
  const id = useId();
  return (
    <label className="choice">
      <input
        type="radio"
        name={name}
        value={option.value}
        checked={checked}
        aria-describedby={id}
        onChange={onSelect}
      />
      <b>{option.title}</b>
      <small id={id}>{option.text}</small>
    </label>
  );
}
