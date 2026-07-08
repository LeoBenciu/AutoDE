import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import type { RootState } from './store';

export const api = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: '/api',
    prepareHeaders: (headers, { getState }) => {
      const token = (getState() as RootState).auth.accessToken;
      if (token) headers.set('authorization', `Bearer ${token}`);
      return headers;
    },
  }),
  tagTypes: ['Vehicle', 'Party', 'Document', 'Payable', 'ETransport', 'Contract'],
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
      invalidatesTags: ['Vehicle'],
    }),
    updateVehicle: build.mutation<any, { id: number; body: any }>({
      query: ({ id, body }) => ({ url: `/vehicles/${id}`, method: 'PATCH', body }),
      invalidatesTags: (_r, _e, { id }) => ['Vehicle', { type: 'Vehicle', id }],
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
    correctField: build.mutation<any, { id: number; field: string; newValue: string }>({
      query: ({ id, ...body }) => ({ url: `/documents/${id}/corrections`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => ['Document', { type: 'Document', id }],
    }),
    markReviewed: build.mutation<any, number>({
      query: (id) => ({ url: `/documents/${id}/reviewed`, method: 'POST' }),
      invalidatesTags: ['Document'],
    }),
    downloadUrl: build.query<{ url: string }, number>({
      query: (id) => `/documents/${id}/download`,
    }),

    payables: build.query<any[], string | void>({
      query: (status) => ({ url: '/banking/payables', params: status ? { status } : undefined }),
      providesTags: ['Payable'],
    }),
    payableFromDocument: build.mutation<any, number>({
      query: (documentId) => ({ url: `/banking/payables/from-document/${documentId}`, method: 'POST' }),
      invalidatesTags: ['Payable'],
    }),
    approvePayable: build.mutation<any, number>({
      query: (id) => ({ url: `/banking/payables/${id}/approve`, method: 'POST' }),
      invalidatesTags: ['Payable'],
    }),
    submitPayable: build.mutation<any, number>({
      query: (id) => ({ url: `/banking/payables/${id}/submit`, method: 'POST' }),
      invalidatesTags: ['Payable'],
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
  useDocumentsQuery,
  useDocumentQuery,
  useUploadDocumentsMutation,
  useCorrectFieldMutation,
  useMarkReviewedMutation,
  useLazyDownloadUrlQuery,
  usePayablesQuery,
  usePayableFromDocumentMutation,
  useApprovePayableMutation,
  useSubmitPayableMutation,
  useEtransportQuery,
  useLazyEtransportPrefillQuery,
  useCreateEtransportMutation,
  useSubmitEtransportMutation,
  useContractsQuery,
  useGenerateContractMutation,
} = api;
