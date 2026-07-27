CREATE TYPE "PartyIdentifierType" AS ENUM ('CUI', 'CNP', 'FOREIGN_ID');

ALTER TABLE "Party"
ADD COLUMN "identifierType" "PartyIdentifierType";

UPDATE "Party"
SET "identifierType" = CASE
  WHEN "kind" = 'INDIVIDUAL' AND UPPER(COALESCE("country", 'RO')) = 'RO'
    THEN 'CNP'::"PartyIdentifierType"
  WHEN "kind" = 'INDIVIDUAL'
    THEN 'FOREIGN_ID'::"PartyIdentifierType"
  ELSE 'CUI'::"PartyIdentifierType"
END
WHERE "taxId" IS NOT NULL AND BTRIM("taxId") <> '';
