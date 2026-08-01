export type ContractKind = 'vanzare-cumparare' | 'proces-verbal';

export interface ContractTemplateData {
  contractNumber: string;
  date: string;
  seller: {
    name: string;
    taxId?: string | null;
    registration?: string | null;
    address?: string | null;
    city?: string | null;
    county?: string | null;
    country?: string | null;
    iban?: string | null;
    bankName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  buyer: {
    name: string;
    kind: 'INDIVIDUAL' | 'COMPANY';
    identifierType?: string | null;
    taxId?: string | null;
    registration?: string | null;
    address?: string | null;
    city?: string | null;
    county?: string | null;
    country?: string | null;
    iban?: string | null;
    bankName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  vehicle: {
    make: string;
    model: string;
    variant?: string | null;
    vin: string;
    year?: number | null;
    firstRegistered?: string | null;
    mileageKm?: number | null;
    color?: string | null;
  };
  price?: number;
  currency: string;
  priceInWords?: string;
}

export interface ContractPlaceholder {
  token: string;
  label: string;
  block?: boolean;
}

export const DEFAULT_SALE_CONTRACT_TEMPLATE = `# CONTRACT DE VÂNZARE-CUMPĂRARE AUTO
> Nr. {{contract_number}} din {{contract_date}}

## I. PĂRȚILE CONTRACTANTE
1. Vânzătorul: {{seller_name}}, cu sediul în {{seller_address}}, înregistrată la registrul comerțului sub nr. {{seller_registration}}, CUI/CIF {{seller_tax_id}}, denumită în continuare VÂNZĂTOR.

2. Cumpărătorul: {{buyer_name}}, {{buyer_location_phrase}} {{buyer_address}}, identificat(ă) prin {{buyer_identifier_label}} {{buyer_tax_id}}, denumit(ă) în continuare CUMPĂRĂTOR.

Părțile au convenit încheierea prezentului contract în următoarele condiții:

## II. OBIECTUL CONTRACTULUI
Vânzătorul vinde, iar cumpărătorul cumpără autovehiculul descris mai jos:

{{vehicle_details}}

## III. PREȚUL ȘI MODALITATEA DE PLATĂ
Prețul total de vânzare este de {{price_formatted}} {{currency}} ({{price_in_words}}) și se achită conform documentelor fiscale și înțelegerii dintre părți.

## IV. PREDAREA AUTOVEHICULULUI
Predarea autovehiculului, a cheilor, a documentelor și a accesoriilor se consemnează prin proces-verbal de predare-primire. Riscurile privind autovehiculul se transferă cumpărătorului la momentul predării efective.

## V. DECLARAȚII ȘI GARANȚII
Vânzătorul declară că are dreptul de a înstrăina autovehiculul și că acesta nu este gajat, sechestrat sau urmărit, cu excepția situațiilor comunicate în scris cumpărătorului. Cumpărătorul confirmă că a inspectat autovehiculul și a primit informațiile disponibile privind starea acestuia. Prezenta clauză nu limitează drepturile legale ale consumatorului privind conformitatea bunurilor.

## VI. DISPOZIȚII FINALE
Orice modificare a prezentului contract se face în scris, prin acordul părților. Contractul a fost încheiat astăzi, {{contract_date}}, în două exemplare, câte unul pentru fiecare parte.

{{signature_block}}`;

export const DEFAULT_HANDOVER_PROTOCOL_TEMPLATE = `# PROCES-VERBAL DE PREDARE-PRIMIRE AUTOVEHICUL
> Nr. {{contract_number}} din {{contract_date}}

## I. PĂRȚILE
Vânzător: {{seller_name}}, CUI/CIF {{seller_tax_id}}, cu sediul în {{seller_address}}.

Cumpărător: {{buyer_name}}, {{buyer_identifier_label}} {{buyer_tax_id}}, {{buyer_location_phrase}} {{buyer_address}}.

## II. AUTOVEHICULUL PREDAT
Astăzi, {{contract_date}}, vânzătorul predă, iar cumpărătorul primește următorul autovehicul:

{{vehicle_details}}

## III. DOCUMENTE, CHEI ȘI ACCESORII
- Chei predate: ______________________________
- Cartea de identitate a vehiculului (CIV): ______________________________
- Certificatul de înmatriculare: ______________________________
- Documente de service / garanție: ______________________________
- Alte accesorii sau documente: ______________________________

## IV. CONSTATĂRI LA PREDARE
Kilometrajul indicat la predare este cel înscris mai sus. Cumpărătorul confirmă primirea autovehiculului, a cheilor și a documentelor menționate.

Observații privind starea sau elementele predate:
________________________________________________________________________________
________________________________________________________________________________

Procesul-verbal a fost încheiat în două exemplare, câte unul pentru fiecare parte.

{{signature_block}}`;

export const CONTRACT_PLACEHOLDERS: ContractPlaceholder[] = [
  { token: '{{contract_number}}', label: 'Număr document' },
  { token: '{{contract_date}}', label: 'Data documentului' },
  { token: '{{seller_name}}', label: 'Denumire vânzător' },
  { token: '{{seller_tax_id}}', label: 'CUI/CIF vânzător' },
  { token: '{{seller_registration}}', label: 'Nr. registrul comerțului' },
  { token: '{{seller_address}}', label: 'Adresă vânzător' },
  { token: '{{seller_city}}', label: 'Localitate vânzător' },
  { token: '{{seller_county}}', label: 'Județ vânzător' },
  { token: '{{seller_country}}', label: 'Țară vânzător' },
  { token: '{{seller_iban}}', label: 'IBAN vânzător' },
  { token: '{{seller_bank}}', label: 'Bancă vânzător' },
  { token: '{{seller_email}}', label: 'Email vânzător' },
  { token: '{{seller_phone}}', label: 'Telefon vânzător' },
  { token: '{{buyer_name}}', label: 'Nume cumpărător' },
  { token: '{{buyer_identifier_label}}', label: 'Tip identificator cumpărător' },
  { token: '{{buyer_tax_id}}', label: 'CNP/CUI cumpărător' },
  { token: '{{buyer_registration}}', label: 'Nr. registrul cumpărătorului' },
  { token: '{{buyer_location_phrase}}', label: 'Formulare domiciliu/sediu' },
  { token: '{{buyer_address}}', label: 'Adresă cumpărător' },
  { token: '{{buyer_city}}', label: 'Localitate cumpărător' },
  { token: '{{buyer_county}}', label: 'Județ cumpărător' },
  { token: '{{buyer_country}}', label: 'Țară cumpărător' },
  { token: '{{buyer_iban}}', label: 'IBAN cumpărător' },
  { token: '{{buyer_bank}}', label: 'Bancă cumpărător' },
  { token: '{{buyer_email}}', label: 'Email cumpărător' },
  { token: '{{buyer_phone}}', label: 'Telefon cumpărător' },
  { token: '{{vehicle_make}}', label: 'Marcă' },
  { token: '{{vehicle_model}}', label: 'Model' },
  { token: '{{vehicle_variant}}', label: 'Variantă' },
  { token: '{{vehicle_vin}}', label: 'Serie șasiu (VIN)' },
  { token: '{{vehicle_year}}', label: 'An fabricație' },
  { token: '{{vehicle_first_registration}}', label: 'Prima înmatriculare' },
  { token: '{{vehicle_mileage}}', label: 'Kilometraj' },
  { token: '{{vehicle_color}}', label: 'Culoare' },
  { token: '{{price_formatted}}', label: 'Preț formatat' },
  { token: '{{currency}}', label: 'Monedă' },
  { token: '{{price_in_words}}', label: 'Preț în litere' },
  { token: '{{vehicle_details}}', label: 'Tabel complet vehicul', block: true },
  { token: '{{signature_block}}', label: 'Semnăturile părților', block: true },
  { token: '{{page_break}}', label: 'Început de pagină nouă', block: true },
];

const ALLOWED_PLACEHOLDER_NAMES = new Set(
  CONTRACT_PLACEHOLDERS.map(({ token }) => token.slice(2, -2)),
);
const BLOCK_PLACEHOLDER_NAMES = CONTRACT_PLACEHOLDERS.filter(
  ({ block }) => block,
).map(({ token }) => token.slice(2, -2));

export function defaultTemplateFor(kind: ContractKind): string {
  return kind === 'vanzare-cumparare'
    ? DEFAULT_SALE_CONTRACT_TEMPLATE
    : DEFAULT_HANDOVER_PROTOCOL_TEMPLATE;
}

export function unknownTemplatePlaceholders(template: string): string[] {
  const unknown = new Set<string>();
  for (const match of template.matchAll(/{{([^{}]+)}}/g)) {
    const name = match[1].trim();
    if (!ALLOWED_PLACEHOLDER_NAMES.has(name)) unknown.add(`{{${name}}}`);
  }
  return [...unknown].sort();
}

export function misplacedBlockPlaceholders(template: string): string[] {
  const misplaced = new Set<string>();
  for (const line of template.replace(/\r\n/g, '\n').split('\n')) {
    for (const name of BLOCK_PLACEHOLDER_NAMES) {
      const occurrence = new RegExp(`{{\\s*${name}\\s*}}`);
      const wholeLine = new RegExp(`^\\s*{{\\s*${name}\\s*}}\\s*$`);
      if (occurrence.test(line) && !wholeLine.test(line)) {
        misplaced.add(`{{${name}}}`);
      }
    }
  }
  return [...misplaced].sort();
}

export function templateValues(data: ContractTemplateData): Record<string, string> {
  const missing = '________________';
  const optional = (value: unknown) => {
    const text = value == null ? '' : String(value).trim();
    return text || missing;
  };
  const buyerIdentifierLabel =
    data.buyer.kind === 'COMPANY'
      ? 'CUI/CIF'
      : data.buyer.identifierType === 'FOREIGN_ID'
        ? 'act de identitate'
        : 'CNP';
  const formattedPrice =
    data.price == null
      ? missing
      : data.price.toLocaleString('ro-RO', {
          minimumFractionDigits: Number.isInteger(data.price) ? 0 : 2,
          maximumFractionDigits: 2,
        });

  return {
    contract_number: optional(data.contractNumber),
    contract_date: optional(data.date),
    seller_name: optional(data.seller.name),
    seller_tax_id: optional(data.seller.taxId),
    seller_registration: optional(data.seller.registration),
    seller_address: optional(data.seller.address),
    seller_city: optional(data.seller.city),
    seller_county: optional(data.seller.county),
    seller_country: optional(data.seller.country),
    seller_iban: optional(data.seller.iban),
    seller_bank: optional(data.seller.bankName),
    seller_email: optional(data.seller.email),
    seller_phone: optional(data.seller.phone),
    buyer_name: optional(data.buyer.name),
    buyer_identifier_label: buyerIdentifierLabel,
    buyer_tax_id: optional(data.buyer.taxId),
    buyer_registration: optional(data.buyer.registration),
    buyer_location_phrase:
      data.buyer.kind === 'COMPANY' ? 'cu sediul în' : 'domiciliat(ă) în',
    buyer_address: optional(data.buyer.address),
    buyer_city: optional(data.buyer.city),
    buyer_county: optional(data.buyer.county),
    buyer_country: optional(data.buyer.country),
    buyer_iban: optional(data.buyer.iban),
    buyer_bank: optional(data.buyer.bankName),
    buyer_email: optional(data.buyer.email),
    buyer_phone: optional(data.buyer.phone),
    vehicle_make: optional(data.vehicle.make),
    vehicle_model: optional(data.vehicle.model),
    vehicle_variant: optional(data.vehicle.variant),
    vehicle_vin: optional(data.vehicle.vin),
    vehicle_year: optional(data.vehicle.year),
    vehicle_first_registration: optional(data.vehicle.firstRegistered),
    vehicle_mileage:
      data.vehicle.mileageKm == null
        ? missing
        : `${data.vehicle.mileageKm.toLocaleString('ro-RO')} km`,
    vehicle_color: optional(data.vehicle.color),
    price_formatted: formattedPrice,
    currency: optional(data.currency),
    price_in_words: optional(data.priceInWords),
  };
}

export function substituteTemplateLine(
  line: string,
  values: Record<string, string>,
): string {
  return line.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (token, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : token,
  );
}
