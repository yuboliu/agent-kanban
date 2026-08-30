import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useSession } from "./lib/auth-client";
import { AccountSettingsPage } from "./routes/AccountSettingsPage";
import { AgentDetailPage } from "./routes/AgentDetailPage";
import { AgentEditPage } from "./routes/AgentEditPage";
import { AgentNewPage } from "./routes/AgentNewPage";
import { AgentsPage } from "./routes/AgentsPage";
import { AuthCallbackPage } from "./routes/AuthCallbackPage";
import { AuthPage } from "./routes/AuthPage";
import { AutomationPage } from "./routes/AutomationPage";
import { AdminDashboardPage } from "./routes/admin/AdminDashboardPage";
import { AdminLayout } from "./routes/admin/AdminLayout";
import { AdminMachinesPage } from "./routes/admin/AdminMachinesPage";
import { AdminUsersPage } from "./routes/admin/AdminUsersPage";
import { BoardLabelsPage } from "./routes/BoardLabelsPage";
import { BoardPage } from "./routes/BoardPage";
import { BoardRedirect } from "./routes/BoardRedirect";
import { BoardSettingsPage } from "./routes/BoardSettingsPage";
import { LandingPage } from "./routes/LandingPage";
import { MachineDetailPage } from "./routes/MachineDetailPage";
import { MachinesPage } from "./routes/MachinesPage";
import { MaintainerDetailPage } from "./routes/MaintainerDetailPage";
import { MockChatPage } from "./routes/MockChatPage";
import { NewBoardPage } from "./routes/NewBoardPage";
import { OnboardingPage } from "./routes/OnboardingPage";
import { RepositoriesPage } from "./routes/RepositoriesPage";
import { SharePage } from "./routes/SharePage";
import { SkillsPage } from "./routes/SkillsPage";

function isUsernameUnconfirmed(session: unknown): boolean {
  if (!session) return false;
  const user = (session as { user?: { usernameConfirmed?: boolean | null } }).user;
  return user?.usernameConfirmed === false;
}

function UsernameGate({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) return null;
  if (isUsernameUnconfirmed(session) && !location.pathname.startsWith("/settings/profile")) {
    // Legacy accounts must confirm/change their username before using the app.
    // The profile page itself is where the confirmation happens, so it is
    // exempt from the redirect (otherwise it would loop on the same URL).
    return <Navigate to="/settings/profile?confirm=1" replace />;
  }
  return children;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) return null;
  if (!session) return <Navigate to="/auth" replace />;
  return <UsernameGate>{children}</UsernameGate>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) return null;
  if (!session) return <Navigate to="/auth" replace />;
  if ((session.user as any).role !== "admin") return <Navigate to="/" replace />;
  return <UsernameGate>{children}</UsernameGate>;
}

function RootRoute() {
  const { data: session, isPending } = useSession();

  if (isPending) return null;
  if (!session) return <LandingPage />;
  if (isUsernameUnconfirmed(session)) return <Navigate to="/settings/profile?confirm=1" replace />;
  return <BoardRedirect />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/mock/chat" element={<MockChatPage />} />
        <Route path="/share/:slug" element={<SharePage />} />
        <Route path="/" element={<RootRoute />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <OnboardingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/new"
          element={
            <ProtectedRoute>
              <NewBoardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId"
          element={
            <ProtectedRoute>
              <BoardPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId/settings"
          element={
            <ProtectedRoute>
              <BoardSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId/maintainers/:maintainerId"
          element={
            <ProtectedRoute>
              <MaintainerDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId/automations"
          element={
            <ProtectedRoute>
              <AutomationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/boards/:boardId/labels"
          element={
            <ProtectedRoute>
              <BoardLabelsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/machines"
          element={
            <ProtectedRoute>
              <MachinesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/machines/:id"
          element={
            <ProtectedRoute>
              <MachineDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents"
          element={
            <ProtectedRoute>
              <AgentsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents/new"
          element={
            <ProtectedRoute>
              <AgentNewPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents/:id"
          element={
            <ProtectedRoute>
              <AgentDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/agents/:id/edit"
          element={
            <ProtectedRoute>
              <AgentEditPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/repositories"
          element={
            <ProtectedRoute>
              <RepositoriesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/skills"
          element={
            <ProtectedRoute>
              <SkillsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <Navigate to="/settings/profile" replace />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings/*"
          element={
            <ProtectedRoute>
              <AccountSettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/admin"
          element={
            <AdminRoute>
              <AdminLayout />
            </AdminRoute>
          }
        >
          <Route index element={<AdminDashboardPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="machines" element={<AdminMachinesPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
