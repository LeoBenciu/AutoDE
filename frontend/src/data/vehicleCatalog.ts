export type VehicleBrand = {
  name: string;
  models: string[];
};

export const VEHICLE_BRANDS: VehicleBrand[] = [
  { name: 'Alfa Romeo', models: ['147', '156', '159', 'Giulia', 'Giulietta', 'MiTo', 'Stelvio', 'Tonale'] },
  { name: 'Audi', models: ['A1', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'Q2', 'Q3', 'Q4 e-tron', 'Q5', 'Q7', 'Q8', 'TT', 'e-tron', 'e-tron GT'] },
  { name: 'BMW', models: ['Seria 1', 'Seria 2', 'Seria 3', 'Seria 4', 'Seria 5', 'Seria 6', 'Seria 7', 'Seria 8', 'X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'i3', 'i4', 'i5', 'i7', 'iX', 'Z4'] },
  { name: 'Chevrolet', models: ['Aveo', 'Camaro', 'Captiva', 'Corvette', 'Cruze', 'Malibu', 'Orlando', 'Spark', 'Trax'] },
  { name: 'Citroën', models: ['Berlingo', 'C1', 'C3', 'C3 Aircross', 'C4', 'C4 Cactus', 'C4 Picasso', 'C5', 'C5 Aircross', 'C5 X', 'Jumper', 'Jumpy'] },
  { name: 'CUPRA', models: ['Ateca', 'Born', 'Formentor', 'Leon', 'Tavascan', 'Terramar'] },
  { name: 'Dacia', models: ['Bigster', 'Dokker', 'Duster', 'Jogger', 'Lodgy', 'Logan', 'Sandero', 'Spring'] },
  { name: 'Fiat', models: ['500', '500L', '500X', 'Bravo', 'Doblo', 'Ducato', 'Freemont', 'Grande Punto', 'Panda', 'Punto', 'Tipo'] },
  { name: 'Ford', models: ['B-Max', 'C-Max', 'EcoSport', 'Edge', 'Explorer', 'Fiesta', 'Focus', 'Galaxy', 'Kuga', 'Mondeo', 'Mustang', 'Puma', 'Ranger', 'S-Max', 'Tourneo', 'Transit'] },
  { name: 'Honda', models: ['Accord', 'Civic', 'CR-V', 'e', 'FR-V', 'HR-V', 'Jazz', 'ZR-V'] },
  { name: 'Hyundai', models: ['Bayon', 'i10', 'i20', 'i30', 'i40', 'IONIQ', 'IONIQ 5', 'IONIQ 6', 'Kona', 'Santa Fe', 'Tucson'] },
  { name: 'Jeep', models: ['Avenger', 'Cherokee', 'Compass', 'Grand Cherokee', 'Patriot', 'Renegade', 'Wrangler'] },
  { name: 'Kia', models: ['Carens', 'Ceed', 'EV3', 'EV6', 'Niro', 'Optima', 'Picanto', 'ProCeed', 'Rio', 'Sorento', 'Soul', 'Sportage', 'Stinger', 'Stonic', 'XCeed'] },
  { name: 'Land Rover', models: ['Defender', 'Discovery', 'Discovery Sport', 'Freelander', 'Range Rover', 'Range Rover Evoque', 'Range Rover Sport', 'Range Rover Velar'] },
  { name: 'Lexus', models: ['CT', 'ES', 'GS', 'IS', 'LBX', 'LS', 'NX', 'RC', 'RX', 'RZ', 'UX'] },
  { name: 'Mazda', models: ['2', '3', '5', '6', 'CX-3', 'CX-30', 'CX-5', 'CX-60', 'CX-80', 'MX-30', 'MX-5'] },
  { name: 'Mercedes-Benz', models: ['Clasa A', 'Clasa B', 'Clasa C', 'Clasa E', 'Clasa G', 'Clasa S', 'CLA', 'CLC', 'CLE', 'CLK', 'CLS', 'EQA', 'EQB', 'EQC', 'EQE', 'EQS', 'GLA', 'GLB', 'GLC', 'GLE', 'GLK', 'GLS', 'SL', 'Sprinter', 'Vito', 'Clasa V'] },
  { name: 'MINI', models: ['Clubman', 'Cooper', 'Cooper S', 'Countryman', 'Paceman'] },
  { name: 'Mitsubishi', models: ['ASX', 'Colt', 'Eclipse Cross', 'L200', 'Lancer', 'Outlander', 'Pajero', 'Space Star'] },
  { name: 'Nissan', models: ['Ariya', 'Juke', 'Leaf', 'Micra', 'Murano', 'Navara', 'Note', 'Pathfinder', 'Primastar', 'Pulsar', 'Qashqai', 'X-Trail'] },
  { name: 'Opel', models: ['Adam', 'Agila', 'Ampera', 'Antara', 'Astra', 'Cascada', 'Combo', 'Corsa', 'Crossland', 'Grandland', 'Insignia', 'Meriva', 'Mokka', 'Movano', 'Vivaro', 'Zafira'] },
  { name: 'Peugeot', models: ['107', '108', '2008', '206', '207', '208', '3008', '307', '308', '4007', '407', '408', '5008', '508', 'Boxer', 'Expert', 'Partner', 'Rifter'] },
  { name: 'Porsche', models: ['718 Boxster', '718 Cayman', '911', 'Cayenne', 'Macan', 'Panamera', 'Taycan'] },
  { name: 'Renault', models: ['Arkana', 'Austral', 'Captur', 'Clio', 'Espace', 'Fluence', 'Kadjar', 'Kangoo', 'Koleos', 'Laguna', 'Master', 'Megane', 'Rafale', 'Scenic', 'Symbol', 'Talisman', 'Trafic', 'Zoe'] },
  { name: 'SEAT', models: ['Alhambra', 'Altea', 'Arona', 'Ateca', 'Cordoba', 'Exeo', 'Ibiza', 'Leon', 'Tarraco', 'Toledo'] },
  { name: 'Škoda', models: ['Citigo', 'Elroq', 'Enyaq', 'Fabia', 'Kamiq', 'Karoq', 'Kodiaq', 'Octavia', 'Rapid', 'Roomster', 'Scala', 'Superb', 'Yeti'] },
  { name: 'Subaru', models: ['BRZ', 'Crosstrek', 'Forester', 'Impreza', 'Legacy', 'Levorg', 'Outback', 'Solterra', 'XV'] },
  { name: 'Suzuki', models: ['Across', 'Baleno', 'Grand Vitara', 'Ignis', 'Jimny', 'S-Cross', 'Swift', 'Vitara'] },
  { name: 'Tesla', models: ['Model 3', 'Model S', 'Model X', 'Model Y'] },
  { name: 'Toyota', models: ['Auris', 'Avensis', 'Aygo', 'C-HR', 'Camry', 'Corolla', 'Highlander', 'Hilux', 'Land Cruiser', 'Prius', 'Proace', 'RAV4', 'Yaris', 'Yaris Cross'] },
  { name: 'Volkswagen', models: ['Amarok', 'Arteon', 'Beetle', 'Caddy', 'Caravelle', 'Crafter', 'Golf', 'ID.3', 'ID.4', 'ID.5', 'ID.7', 'Jetta', 'Passat', 'Phaeton', 'Polo', 'Scirocco', 'Sharan', 'T-Cross', 'T-Roc', 'Taigo', 'Tiguan', 'Touareg', 'Touran', 'Transporter', 'up!'] },
  { name: 'Volvo', models: ['C30', 'C40', 'EC40', 'EX30', 'EX40', 'EX90', 'S40', 'S60', 'S80', 'S90', 'V40', 'V50', 'V60', 'V70', 'V90', 'XC40', 'XC60', 'XC70', 'XC90'] },
];

export const VEHICLE_COUNTRIES = [
  { code: 'AT', name: 'Austria', flag: '🇦🇹' },
  { code: 'BE', name: 'Belgia', flag: '🇧🇪' },
  { code: 'BG', name: 'Bulgaria', flag: '🇧🇬' },
  { code: 'CH', name: 'Elveția', flag: '🇨🇭' },
  { code: 'CZ', name: 'Cehia', flag: '🇨🇿' },
  { code: 'DE', name: 'Germania', flag: '🇩🇪' },
  { code: 'DK', name: 'Danemarca', flag: '🇩🇰' },
  { code: 'ES', name: 'Spania', flag: '🇪🇸' },
  { code: 'FI', name: 'Finlanda', flag: '🇫🇮' },
  { code: 'FR', name: 'Franța', flag: '🇫🇷' },
  { code: 'GB', name: 'Regatul Unit', flag: '🇬🇧' },
  { code: 'HU', name: 'Ungaria', flag: '🇭🇺' },
  { code: 'IT', name: 'Italia', flag: '🇮🇹' },
  { code: 'LT', name: 'Lituania', flag: '🇱🇹' },
  { code: 'LU', name: 'Luxemburg', flag: '🇱🇺' },
  { code: 'NL', name: 'Țările de Jos', flag: '🇳🇱' },
  { code: 'NO', name: 'Norvegia', flag: '🇳🇴' },
  { code: 'PL', name: 'Polonia', flag: '🇵🇱' },
  { code: 'RO', name: 'România', flag: '🇷🇴' },
  { code: 'SE', name: 'Suedia', flag: '🇸🇪' },
  { code: 'SK', name: 'Slovacia', flag: '🇸🇰' },
] as const;

export function modelsForBrand(make: string): string[] {
  return VEHICLE_BRANDS.find((brand) => normalizeBrand(make) === normalizeBrand(brand.name))?.models ?? [];
}

export function normalizeBrand(value: string): string {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  if (normalized === 'vw') return 'volkswagen';
  if (normalized === 'mercedes' || normalized === 'mercedesbenz') return 'mercedesbenz';
  if (normalized === 'skoda') return 'skoda';
  if (normalized === 'citroen') return 'citroen';
  return normalized;
}
