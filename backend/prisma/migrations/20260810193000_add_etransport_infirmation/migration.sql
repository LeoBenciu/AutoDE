ALTER TYPE "ETransportStatus" ADD VALUE IF NOT EXISTS 'INFIRMING';
ALTER TYPE "ETransportStatus" ADD VALUE IF NOT EXISTS 'INFIRMED';

ALTER TABLE "ETransportDeclaration"
ADD COLUMN "infirmationUploadId" TEXT,
ADD COLUMN "infirmationReason" TEXT,
ADD COLUMN "infirmationResponse" JSONB,
ADD COLUMN "infirmedAt" TIMESTAMP(3);
