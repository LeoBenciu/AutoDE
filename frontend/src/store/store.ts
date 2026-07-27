import { configureStore } from '@reduxjs/toolkit';
import type { Middleware } from '@reduxjs/toolkit';
import { api } from './api';
import authReducer from './authSlice';

// Logs every RTK Query request outcome to the browser console so upload/API
// failures are visible in devtools instead of failing silently.
const apiLogger: Middleware = () => (next) => (action: any) => {
  const type: string | undefined = action?.type;
  if (type?.startsWith('api/')) {
    const endpoint = action.meta?.arg?.endpointName ?? 'unknown';
    if (type.endsWith('/pending')) {
      console.log(`[api] → ${endpoint} started`);
    } else if (type.endsWith('/rejected')) {
      console.error(`[api] ✗ ${endpoint} FAILED`, {
        status: action.payload?.status ?? action.error?.name,
        payload: action.payload,
        error: action.error,
      });
    } else if (type.endsWith('/fulfilled')) {
      console.log(`[api] ✓ ${endpoint} ok`, action.payload);
    }
  }
  return next(action);
};

export const store = configureStore({
  reducer: {
    auth: authReducer,
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefault) => getDefault().concat(api.middleware, apiLogger),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
