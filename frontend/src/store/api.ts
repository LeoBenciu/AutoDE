import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { API_BASE_URL } from './apiBase';
import type { RootState } from './store';

export interface ImportResult {
  created: number;
  updated: number;
  total: number;
  errors: string[];
}

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: API_BASE_URL,
    prepareHeaders: (headers, { getState }) => {
      const token = (getState() as RootState).auth.accessToken;
      if (token) headers.set('authorization', `Bearer ${token}`);
      return headers;
    },
  }),
  tagTypes: [
    'Vehicle',
    'Party',
    'Document',
    'ETransport',
    'Contract',
    'User',
    'Accounting',
    'Saga',
  ],
  endpoints: (build) => ({
    login: build.mutation<any, { email: string; password: string }>({
      query: (body) => ({ url: '/auth/login', method: 'POST', body }),
    }),
    register: build.mutation<any, { companyName: string; name: string; email: string; password: string }>({
      query: (body) => ({ url: '/auth/register', method: 'POST', body }),
    }),

    vehicles: build.query<any[], { status?: string; search?: string } | void>({
      query: (params) => ({ url: '/vehicles', params: params ?? undefined }),
      providesTags: ['Vehicle'],
    }),
    vehicle: build.query<any, number>({
      query: (id) => `/vehicles/${id}`,
      providesTags: (_r, _e, id) => [{ type: 'Vehicle', id }],
    }),
    createVehicle: build.mutation<any, any>({
      query: (body) => ({ url: '/vehicles', method: 'POST', body }),
      invalidatesTags: ['Vehicle', 'Party'],
    }),
    updateVehicle: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({ url: `/vehicles/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id }) => ['Vehicle', { type: 'Vehicle', id }, 'Party'],
    }),
    addCost: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({ url: `/vehicles/${id}/costs`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'Vehicle', id }],
    }),

    parties: build.query<any[], string | void>({
      query: (search) => ({ url: '/parties', params: search ? { search } : undefined }),
      providesTags: ['Party'],
    }),
    createParty: build.mutation<any, any>({
      query: (body) => ({ url: '/parties', method: 'POST', body }),
      invalidatesTags: ['Party'],
    }),
    updateParty: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({
        url: `/parties/${id}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: ['Party', 'Saga'],
    }),
    importParties: build.mutation<ImportResult, { file: File; role: 'supplier' | 'client' }>({
      query: ({ file, role }) => {
        const form = new FormData();
        form.append('file', file);
        form.append('role', role);
        return { url: '/parties/import', method: 'POST', body: form };
      },
      invalidatesTags: ['Party', 'Saga'],
    }),

    documents: build.query<{ documents: any[]; pending: any[] }, Record<string, any> | void>({
      query: (params) => ({ url: '/documents', params: params ?? undefined }),
      providesTags: ['Document'],
    }),
    document: build.query<any, number>({
      query: (id) => `/documents/${id}`,
      providesTags: (_r, _e, id) => [{ type: 'Document', id }],
    }),
    uploadDocuments: build.mutation<any, { files: File[]; vehicleId?: number }>({
      query: ({ files, vehicleId }) => {
        const form = new FormData();
        files.forEach((f) => form.append('files', f));
        if (vehicleId) form.append('vehicleId', String(vehicleId));
        return { url: '/documents/upload', method: 'POST', body: form };
      },
      invalidatesTags: ['Document', 'Vehicle'],
    }),
    correctField: build.mutation<any, { id: number; field: string; newValue: unknown }>({
      query: ({ id, ...body }) => ({ url: `/documents/${id}/corrections`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => ['Document', { type: 'Document', id }, 'Accounting', 'Saga'],
    }),
    postingPreview: build.query<any, number>({
      query: (id) => `/documents/${id}/posting-preview`,
      providesTags: (_r, _e, id) => [{ type: 'Accounting', id }],
    }),
    approveDocument: build.mutation<any, number>({
      query: (id) => ({ url: `/documents/${id}/approve`, method: 'POST' }),
      invalidatesTags: ['Document', 'Accounting', 'Party', 'Saga'],
    }),
    reopenDocument: build.mutation<any, number>({
      query: (id) => ({ url: `/documents/${id}/reopen`, method: 'POST' }),
      invalidatesTags: ['Document', 'Accounting', 'Saga'],
    }),
    assignDocument: build.mutation<any, { id: number; vehicleId?: number | null; partyId?: number | null }>({
      query: ({ id, ...body }) => ({ url: `/documents/${id}/assign`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => ['Document', { type: 'Document', id }, 'Vehicle'],
    }),
    archiveDocument: build.mutation<any, { id: number; archived: boolean }>({
      query: ({ id, archived }) => ({ url: `/documents/${id}/${archived ? 'archive' : 'unarchive'}`, method: 'POST' }),
      invalidatesTags: ['Document'],
    }),
    retryPendingUpload: build.mutation<any, number>({
      query: (id) => ({ url: `/documents/pending/${id}/retry`, method: 'POST' }),
      invalidatesTags: ['Document'],
    }),
    cancelPendingUpload: build.mutation<any, number>({
      query: (id) => ({ url: `/documents/pending/${id}/cancel`, method: 'POST' }),
      invalidatesTags: ['Document'],
    }),
    downloadUrl: build.query<{ url: string }, number>({
      query: (id) => `/documents/${id}/download`,
    }),

    etransport: build.query<any[], void>({
      query: () => '/etransport',
      providesTags: ['ETransport'],
    }),
    etransportPrefill: build.query<any, number>({
      query: (vehicleId) => `/etransport/prefill/${vehicleId}`,
    }),
    createEtransport: build.mutation<any, any>({
      query: (body) => ({ url: '/etransport', method: 'POST', body }),
      invalidatesTags: ['ETransport', 'Vehicle'],
    }),
    updateEtransport: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({ url: `/etransport/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['ETransport', 'Vehicle'],
    }),
    submitEtransport: build.mutation<any, number>({
      query: (id) => ({ url: `/etransport/${id}/submit`, method: 'POST' }),
      invalidatesTags: ['ETransport'],
    }),

    contracts: build.query<any[], number | void>({
      query: (vehicleId) => ({ url: '/contracts', params: vehicleId ? { vehicleId } : undefined }),
      providesTags: ['Contract'],
    }),
    generateContract: build.mutation<any, any>({
      query: (body) => ({ url: '/contracts/generate', method: 'POST', body }),
      invalidatesTags: ['Contract', 'Vehicle', 'Document'],
    }),

    users: build.query<any[], void>({
      query: () => '/users',
      providesTags: ['User'],
    }),
    createUser: build.mutation<any, { name: string; email: string; password: string; role: string }>({
      query: (body) => ({ url: '/users', method: 'POST', body }),
      invalidatesTags: ['User'],
    }),
    updateUser: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({ url: `/users/${id}`, method: 'PATCH', body }),
      invalidatesTags: ['User'],
    }),

    company: build.query<any, void>({
      query: () => '/accounting/company',
      providesTags: ['Accounting'],
    }),
    companyFromAnaf: build.query<any, { cui: string; requestId: string }>({
      query: ({ cui, requestId }) => ({
        url: `/accounting/company/anaf/${encodeURIComponent(cui)}`,
        headers: { 'x-request-id': requestId },
      }),
    }),
    updateCompany: build.mutation<any, any>({
      query: (body) => ({ url: '/accounting/company', method: 'PATCH', body }),
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    ledger: build.query<any, Record<string, any> | void>({
      query: (params) => ({ url: '/accounting/ledger', params: params ?? undefined }),
      providesTags: ['Accounting'],
    }),
    chartOfAccounts: build.query<any[], string | void>({
      query: (search) => ({
        url: '/accounting/accounts',
        params: search ? { search } : undefined,
      }),
      providesTags: ['Accounting'],
    }),
    articles: build.query<any[], string | void>({
      query: (search) => ({
        url: '/accounting/articles',
        params: search ? { search } : undefined,
      }),
      providesTags: ['Accounting'],
    }),
    createArticle: build.mutation<any, any>({
      query: (body) => ({ url: '/accounting/articles', method: 'POST', body }),
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    updateArticle: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({
        url: `/accounting/articles/${id}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    importArticles: build.mutation<ImportResult, File>({
      query: (file) => {
        const form = new FormData();
        form.append('file', file);
        return { url: '/accounting/articles/import', method: 'POST', body: form };
      },
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    managements: build.query<any[], void>({
      query: () => '/accounting/managements',
      providesTags: ['Accounting'],
    }),
    createManagement: build.mutation<any, any>({
      query: (body) => ({
        url: '/accounting/managements',
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    updateManagement: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({
        url: `/accounting/managements/${id}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    importManagements: build.mutation<ImportResult, File>({
      query: (file) => {
        const form = new FormData();
        form.append('file', file);
        return { url: '/accounting/managements/import', method: 'POST', body: form };
      },
      invalidatesTags: ['Accounting', 'Saga'],
    }),
    sagaPreview: build.mutation<any, any>({
      query: (body) => ({ url: '/saga/preview', method: 'POST', body }),
    }),
    sagaPreferences: build.query<any | null, void>({
      query: () => '/saga/preferences',
      providesTags: ['Saga'],
    }),
    saveSagaPreferences: build.mutation<any, any>({
      query: (body) => ({ url: '/saga/preferences', method: 'POST', body }),
      invalidatesTags: ['Saga'],
    }),
  }),
});

export const {
  useLoginMutation,
  useRegisterMutation,
  useVehiclesQuery,
  useVehicleQuery,
  useCreateVehicleMutation,
  useUpdateVehicleMutation,
  useAddCostMutation,
  usePartiesQuery,
  useCreatePartyMutation,
  useUpdatePartyMutation,
  useImportPartiesMutation,
  useDocumentsQuery,
  useDocumentQuery,
  useUploadDocumentsMutation,
  useCorrectFieldMutation,
  usePostingPreviewQuery,
  useApproveDocumentMutation,
  useReopenDocumentMutation,
  useAssignDocumentMutation,
  useArchiveDocumentMutation,
  useRetryPendingUploadMutation,
  useCancelPendingUploadMutation,
  useLazyDownloadUrlQuery,
  useEtransportQuery,
  useLazyEtransportPrefillQuery,
  useCreateEtransportMutation,
  useUpdateEtransportMutation,
  useSubmitEtransportMutation,
  useContractsQuery,
  useGenerateContractMutation,
  useUsersQuery,
  useCreateUserMutation,
  useUpdateUserMutation,
  useCompanyQuery,
  useLazyCompanyFromAnafQuery,
  useUpdateCompanyMutation,
  useLedgerQuery,
  useChartOfAccountsQuery,
  useArticlesQuery,
  useCreateArticleMutation,
  useUpdateArticleMutation,
  useImportArticlesMutation,
  useManagementsQuery,
  useCreateManagementMutation,
  useUpdateManagementMutation,
  useImportManagementsMutation,
  useSagaPreviewMutation,
  useSagaPreferencesQuery,
  useSaveSagaPreferencesMutation,
} = api;
