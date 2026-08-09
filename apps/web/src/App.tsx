import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AdminArea } from "./admin-pages";
import { AppHeader } from "./components";
import { LeaderboardPage, LivePage, ReplayPage, TournamentsPage } from "./public-pages";

export function App() {
  const location = useLocation();
  if (location.pathname.startsWith("/admin")) return <AdminArea />;
  return (
    <>
      <AppHeader />
      <Routes>
        <Route path="/" element={<LivePage />} />
        <Route path="/tournaments" element={<TournamentsPage />} />
        <Route path="/tournaments/:id/replay" element={<ReplayPage />} />
        <Route path="/tournaments/:id/replay/:handNo" element={<ReplayPage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
