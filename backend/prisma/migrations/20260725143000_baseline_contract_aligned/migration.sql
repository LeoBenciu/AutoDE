-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT', 'VIEWER');

-- CreateEnum
CREATE TYPE "PartyKind" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('SOURCED', 'PURCHASED', 'IN_TRANSIT', 'CUSTOMS', 'IN_STOCK', 'RESERVED', 'SOLD', 'DELIVERED');

-- CreateEnum
CREATE TYPE "CostCategory" AS ENUM ('PURCHASE', 'TRANSPORT', 'CUSTOMS', 'VAT', 'ITP', 'REGISTRATION', 'REFURB', 'OTHER');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "DocumentReviewStatus" AS ENUM ('LEGACY', 'PENDING_APPROVAL', 'APPROVED', 'REOPENED');

-- CreateEnum
CREATE TYPE "PostingStatus" AS ENUM ('NONE', 'POSTED', 'ERROR');

-- CreateEnum
CREATE TYPE "LedgerSourceType" AS ENUM ('INVOICE_IN', 'INVOICE_OUT', 'RECEIPT', 'RECEIPT_IN', 'RECEIPT_OUT', 'PAYMENT_DISPOSITION', 'COLLECTION_DISPOSITION');

-- CreateEnum
CREATE TYPE "PendingUploadStatus" AS ENUM ('QUEUED', 'UPLOADED', 'PROCESSING', 'PHASE0_COMPLETE', 'PHASE1_COMPLETE', 'COMPLETED', 'ERROR', 'CANCELLED', 'SPLIT');

-- CreateEnum
CREATE TYPE "ContractDirection" AS ENUM ('INCOMING', 'OUTGOING');

-- CreateEnum
CREATE TYPE "ETransportStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'VALIDATED', 'CONFIRMED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cui" TEXT,
    "registrationNumber" TEXT,
    "address" TEXT,
    "country" TEXT NOT NULL DEFAULT 'RO',
    "county" TEXT,
    "city" TEXT,
    "iban" TEXT,
    "bankName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'RON',
    "isVatPayer" BOOLEAN NOT NULL DEFAULT true,
    "hasTvaLaIncasare" BOOLEAN NOT NULL DEFAULT false,
    "accountingCutoverAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sagaExportConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" SERIAL NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Party" (
    "id" SERIAL NOT NULL,
    "kind" "PartyKind" NOT NULL DEFAULT 'COMPANY',
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "isSupplier" BOOLEAN NOT NULL DEFAULT false,
    "isClient" BOOLEAN NOT NULL DEFAULT false,
    "supplierCode" TEXT,
    "clientCode" TEXT,
    "supplierAnalytic" TEXT,
    "clientAnalytic" TEXT,
    "registration" TEXT,
    "country" TEXT NOT NULL DEFAULT 'RO',
    "county" TEXT,
    "city" TEXT,
    "address" TEXT,
    "iban" TEXT,
    "bankName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "discount" TEXT,
    "tenantId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "analyticCode" TEXT,
    "vatRate" TEXT NOT NULL DEFAULT 'TWENTYONE',
    "unit" TEXT NOT NULL DEFAULT 'BUCATA',
    "type" TEXT NOT NULL DEFAULT 'MARFURI',
    "accountCode" TEXT,
    "management" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Management" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'CANTITATIV_VALORICA',
    "analyticCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Management_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChartOfAccount" (
    "id" SERIAL NOT NULL,
    "accountCode" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChartOfAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" SERIAL NOT NULL,
    "vin" TEXT NOT NULL,
    "make" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "variant" TEXT,
    "firstRegistered" TIMESTAMP(3),
    "year" INTEGER NOT NULL,
    "mileageKm" INTEGER,
    "fuelType" TEXT,
    "gearbox" TEXT,
    "color" TEXT,
    "originCountry" TEXT NOT NULL DEFAULT 'DE',
    "status" "VehicleStatus" NOT NULL DEFAULT 'SOURCED',
    "purchasePrice" DECIMAL(12,2) NOT NULL,
    "purchaseCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "landedCost" DECIMAL(12,2),
    "listPrice" DECIMAL(12,2),
    "soldPrice" DECIMAL(12,2),
    "soldCurrency" TEXT NOT NULL DEFAULT 'RON',
    "tenantId" INTEGER NOT NULL,
    "buyerId" INTEGER,
    "sellerId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehicleCost" (
    "id" SERIAL NOT NULL,
    "vehicleId" INTEGER NOT NULL,
    "category" "CostCategory" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "note" TEXT,
    "documentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VehicleCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "s3Key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "documentHash" TEXT NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "vehicleId" INTEGER,
    "partyId" INTEGER,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewStatus" "DocumentReviewStatus" NOT NULL DEFAULT 'LEGACY',
    "postingStatus" "PostingStatus" NOT NULL DEFAULT 'NONE',
    "approvedAt" TIMESTAMP(3),
    "approvedById" INTEGER,
    "postedAt" TIMESTAMP(3),
    "postingError" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "processingCompletedAt" TIMESTAMP(3),
    "phase0StartedAt" TIMESTAMP(3),
    "phase0CompletedAt" TIMESTAMP(3),
    "phase0Duration" INTEGER,
    "phase1StartedAt" TIMESTAMP(3),
    "phase1CompletedAt" TIMESTAMP(3),
    "phase1Duration" INTEGER,
    "processingDuration" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedData" (
    "id" SERIAL NOT NULL,
    "documentId" INTEGER NOT NULL,
    "documentType" TEXT,
    "typeConfidence" DOUBLE PRECISION,
    "extractedFields" JSONB NOT NULL,
    "fieldConfidence" JSONB,
    "validationIssues" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessedData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRelationship" (
    "id" SERIAL NOT NULL,
    "parentId" INTEGER NOT NULL,
    "childId" INTEGER NOT NULL,
    "relation" TEXT,
    "paymentAmount" DECIMAL(14,2),
    "notes" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GeneralLedgerEntry" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "postingDate" TIMESTAMP(3) NOT NULL,
    "accountCode" TEXT NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'RON',
    "originalAmount" DECIMAL(14,2),
    "exchangeRate" DECIMAL(14,6),
    "sourceType" "LedgerSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "postingKey" TEXT NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "documentId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneralLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingUpload" (
    "id" SERIAL NOT NULL,
    "s3Key" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "documentHash" TEXT NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "vehicleId" INTEGER,
    "partyId" INTEGER,
    "status" "PendingUploadStatus" NOT NULL DEFAULT 'QUEUED',
    "processingPhase" INTEGER NOT NULL DEFAULT 0,
    "phase0Data" JSONB,
    "phase1Data" JSONB,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "errorMessage" TEXT,
    "documentId" INTEGER,
    "processingStartedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "parentUploadId" INTEGER,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "segmentIndex" INTEGER,
    "segmentCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCorrection" (
    "id" SERIAL NOT NULL,
    "documentId" INTEGER NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "vehicleId" INTEGER,
    "partyId" INTEGER,
    "direction" "ContractDirection" NOT NULL DEFAULT 'OUTGOING',
    "contractType" TEXT NOT NULL,
    "contractNumber" TEXT,
    "contractDate" TIMESTAMP(3),
    "totalValue" DECIMAL(12,2),
    "currency" TEXT,
    "documentId" INTEGER,
    "extractedFields" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractNumberSequence" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "series" TEXT NOT NULL DEFAULT 'CV',
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "ContractNumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ETransportDeclaration" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "vehicleId" INTEGER,
    "operationType" TEXT NOT NULL DEFAULT 'AIC',
    "uit" TEXT,
    "status" "ETransportStatus" NOT NULL DEFAULT 'DRAFT',
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "declaredAt" TIMESTAMP(3),
    "xmlPayload" TEXT NOT NULL,
    "anafUploadId" TEXT,
    "anafResponse" JSONB,
    "invoiceDocumentId" INTEGER,
    "uitDocumentId" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "transporter" JSONB NOT NULL,
    "vehiclePlate" TEXT,
    "trailerPlate" TEXT,
    "loadingPlace" JSONB NOT NULL,
    "unloadingPlace" JSONB NOT NULL,
    "goods" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ETransportDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnafToken" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnafToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "tenantId" INTEGER NOT NULL,
    "userId" INTEGER,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "Party_tenantId_idx" ON "Party"("tenantId");

-- CreateIndex
CREATE INDEX "Party_tenantId_taxId_idx" ON "Party"("tenantId", "taxId");

-- CreateIndex
CREATE INDEX "Party_tenantId_isSupplier_idx" ON "Party"("tenantId", "isSupplier");

-- CreateIndex
CREATE INDEX "Party_tenantId_isClient_idx" ON "Party"("tenantId", "isClient");

-- CreateIndex
CREATE INDEX "Article_tenantId_name_idx" ON "Article"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Article_tenantId_code_key" ON "Article"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Management_tenantId_code_key" ON "Management"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ChartOfAccount_accountCode_key" ON "ChartOfAccount"("accountCode");

-- CreateIndex
CREATE INDEX "ChartOfAccount_accountType_idx" ON "ChartOfAccount"("accountType");

-- CreateIndex
CREATE INDEX "Vehicle_tenantId_status_idx" ON "Vehicle"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_tenantId_vin_key" ON "Vehicle"("tenantId", "vin");

-- CreateIndex
CREATE INDEX "Document_tenantId_documentHash_idx" ON "Document"("tenantId", "documentHash");

-- CreateIndex
CREATE INDEX "Document_tenantId_vehicleId_idx" ON "Document"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "Document_tenantId_reviewStatus_uploadedAt_idx" ON "Document"("tenantId", "reviewStatus", "uploadedAt");

-- CreateIndex
CREATE INDEX "Document_tenantId_postingStatus_postedAt_idx" ON "Document"("tenantId", "postingStatus", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedData_documentId_key" ON "ProcessedData"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRelationship_parentId_childId_key" ON "DocumentRelationship"("parentId", "childId");

-- CreateIndex
CREATE UNIQUE INDEX "GeneralLedgerEntry_postingKey_key" ON "GeneralLedgerEntry"("postingKey");

-- CreateIndex
CREATE INDEX "GeneralLedgerEntry_tenantId_postingDate_idx" ON "GeneralLedgerEntry"("tenantId", "postingDate");

-- CreateIndex
CREATE INDEX "GeneralLedgerEntry_tenantId_accountCode_idx" ON "GeneralLedgerEntry"("tenantId", "accountCode");

-- CreateIndex
CREATE INDEX "GeneralLedgerEntry_tenantId_sourceType_idx" ON "GeneralLedgerEntry"("tenantId", "sourceType");

-- CreateIndex
CREATE INDEX "GeneralLedgerEntry_documentId_idx" ON "GeneralLedgerEntry"("documentId");

-- CreateIndex
CREATE INDEX "PendingUpload_status_updatedAt_idx" ON "PendingUpload"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "PendingUpload_tenantId_status_idx" ON "PendingUpload"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PendingUpload_parentUploadId_idx" ON "PendingUpload"("parentUploadId");

-- CreateIndex
CREATE UNIQUE INDEX "PendingUpload_parentUploadId_segmentIndex_key" ON "PendingUpload"("parentUploadId", "segmentIndex");

-- CreateIndex
CREATE INDEX "UserCorrection_tenantId_field_idx" ON "UserCorrection"("tenantId", "field");

-- CreateIndex
CREATE INDEX "Contract_tenantId_idx" ON "Contract"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractNumberSequence_tenantId_series_key" ON "ContractNumberSequence"("tenantId", "series");

-- CreateIndex
CREATE UNIQUE INDEX "ETransportDeclaration_idempotencyKey_key" ON "ETransportDeclaration"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ETransportDeclaration_tenantId_status_idx" ON "ETransportDeclaration"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AnafToken_tenantId_key" ON "AnafToken"("tenantId");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Party" ADD CONSTRAINT "Party_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Management" ADD CONSTRAINT "Management_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleCost" ADD CONSTRAINT "VehicleCost_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleCost" ADD CONSTRAINT "VehicleCost_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedData" ADD CONSTRAINT "ProcessedData_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRelationship" ADD CONSTRAINT "DocumentRelationship_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRelationship" ADD CONSTRAINT "DocumentRelationship_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRelationship" ADD CONSTRAINT "DocumentRelationship_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneralLedgerEntry" ADD CONSTRAINT "GeneralLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GeneralLedgerEntry" ADD CONSTRAINT "GeneralLedgerEntry_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingUpload" ADD CONSTRAINT "PendingUpload_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingUpload" ADD CONSTRAINT "PendingUpload_parentUploadId_fkey" FOREIGN KEY ("parentUploadId") REFERENCES "PendingUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCorrection" ADD CONSTRAINT "UserCorrection_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCorrection" ADD CONSTRAINT "UserCorrection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ETransportDeclaration" ADD CONSTRAINT "ETransportDeclaration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ETransportDeclaration" ADD CONSTRAINT "ETransportDeclaration_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ETransportDeclaration" ADD CONSTRAINT "ETransportDeclaration_invoiceDocumentId_fkey" FOREIGN KEY ("invoiceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ETransportDeclaration" ADD CONSTRAINT "ETransportDeclaration_uitDocumentId_fkey" FOREIGN KEY ("uitDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnafToken" ADD CONSTRAINT "AnafToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
