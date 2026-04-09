import UserPage from "./components/UserPage";
import AdminPage from "./components/AdminPage";

export default function App() {
  const isAdmin = window.location.pathname.startsWith("/admin");
  return isAdmin ? <AdminPage /> : <UserPage />;
}
