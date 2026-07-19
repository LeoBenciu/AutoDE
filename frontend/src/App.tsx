import { Navigate, Route, Routes } from 'react-router-dom';
import { useSelector } from 'react-redux';
import type { RootState } from './store/store';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Vehicles from './pages/Vehicles';
import VehicleDetail from './pages/VehicleDetail';
import Documents from './pages/Documents';
import ETransport from './pages/ETransport';
import Settings from './pages/Settings';

export default function App() {
  const token = useSelector((s: RootState) => s.auth.accessToken);
  if (!token) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/vehicule" element={<Vehicles />} />
        <Route path="/vehicule/:id" element={<VehicleDetail />} />
        <Route path="/documente" element={<Documents />} />
        <Route path="/e-transport" element={<ETransport />} />
        <Route path="/setari" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
