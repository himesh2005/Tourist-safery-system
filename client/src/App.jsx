import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import Auth from "./pages/Auth.jsx";
import Register from "./pages/Register.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Verify from "./pages/Verify.jsx";
import RouteTransition from "./components/RouteTransition.jsx";

export default function App() {
  const location = useLocation();

  return (
    <div className="app-shell">
      <div className="bg-wave bg-wave-1" />
      <div className="bg-wave bg-wave-2" />
      <div className="bg-particle p-1" />
      <div className="bg-particle p-2" />
      <div className="bg-particle p-3" />

      <RouteTransition routeKey={location.pathname}>
        <Routes location={location}>
          <Route path="/" element={<Navigate to="/auth" replace />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/register" element={<Register />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/verify/:id" element={<Verify />} />
          <Route
            path="*"
            element={<div style={{ padding: 20 }}>Not Found</div>}
          />
        </Routes>
      </RouteTransition>
    </div>
  );
}
