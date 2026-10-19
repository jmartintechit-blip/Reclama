// The columns the CSV import understands, as the import screen explains them. This is a copy of
// what the server's parser accepts (header names without case, accents or punctuation, so
// "N.º factura" and "nº FACTURA" are the same name); a test in server/domain feeds every name
// below to the real parser, so a name listed here that the parser rejects fails the build. Plain
// data, no DOM, so the server's type checker can read it too.

export interface ImportColumn {
  // The canonical field name the server reports in its row errors.
  field:
    | 'number'
    | 'debtorName'
    | 'taxId'
    | 'email'
    | 'issueDate'
    | 'dueDate'
    | 'amount';
  // The name to show first.
  title: string;
  required: boolean;
  // Other header names the parser takes for the same data.
  aliases: string[];
  note?: string;
}

export const IMPORT_COLUMNS: ImportColumn[] = [
  {
    field: 'number',
    title: 'Factura',
    required: true,
    aliases: [
      'Número',
      'Nº',
      'Nº factura',
      'Num',
      'Num factura',
      'Número factura',
      'Nº de factura',
      'Nro',
      'Invoice',
      'Number',
      'Invoice number',
    ],
  },
  {
    field: 'debtorName',
    title: 'Cliente',
    required: true,
    aliases: [
      'Deudor',
      'Nombre',
      'Razón social',
      'Nombre cliente',
      'Nombre deudor',
      'Customer',
      'Debtor',
      'Name',
      'Customer name',
    ],
  },
  {
    field: 'taxId',
    title: 'NIF/CIF',
    required: false,
    aliases: ['NIF', 'CIF', 'CIF/NIF', 'NIF CIF', 'NIF-CIF', 'Tax id'],
    note: 'Si lo pones, dos clientes con el mismo nombre y distinto NIF/CIF cuentan como deudores distintos.',
  },
  {
    field: 'email',
    title: 'Email',
    required: false,
    aliases: ['Correo', 'E-mail', 'Correo electrónico', 'Mail'],
  },
  {
    field: 'issueDate',
    title: 'Fecha de emisión',
    required: true,
    aliases: [
      'Fecha',
      'Fecha emisión',
      'Fecha factura',
      'Emisión',
      'Issue date',
      'Invoice date',
      'Date',
    ],
  },
  {
    field: 'dueDate',
    title: 'Vencimiento',
    required: false,
    aliases: [
      'Fecha vencimiento',
      'Fecha de vencimiento',
      'Vto',
      'Fecha vto',
      'Due date',
      'Due',
    ],
    note: 'Si falta, Reclama estima el vencimiento a 30 días de la emisión.',
  },
  {
    field: 'amount',
    title: 'Importe',
    required: true,
    aliases: ['Total', 'Importe total', 'Total factura', 'Amount'],
  },
];
