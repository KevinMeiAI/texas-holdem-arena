import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AdminArea } from "./admin-pages";
import { AppHeader, SiteFooter } from "./components";
import { DecisionBranchPage } from "./decision-branch-page";
import { MomentPage } from "./moment-page";
import { MomentsPage } from "./moments-page";
import { PlayerPage } from "./player-page";
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
        <Route path="/moments" element={<MomentsPage />} />
        <Route path="/moments/:slug" element={<MomentPage />} />
        <Route path="/branches/:slug" element={<DecisionBranchPage />} />
        <Route path="/players/:competitorId" element={<PlayerPage />} />
        <Route path="/leaderboard" element={<LeaderboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <SiteFooter />
    </>
  );
}
