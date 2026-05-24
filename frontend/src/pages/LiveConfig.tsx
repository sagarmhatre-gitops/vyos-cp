import { useParams } from "react-router-dom";
import { LiveConfigTab } from "./LiveConfigTab";

/**
 * Route wrapper for the Live Config tab.
 * Reads :id from the URL and renders the tab inside the device shell.
 *
 * canCapture is hardcoded true for now — the app has no role context yet
 * (user state in App.tsx is just {id, name}). Backend RBAC still enforces
 * the operator/admin requirement on POST /snapshot, so a viewer hitting
 * "Refresh now" gets a clean 403 from the API. Tighten here once roles
 * flow into the frontend.
 */
export function LiveConfig() {
    const { id } = useParams<{ id: string }>();
    if (!id) return null;
    return <LiveConfigTab deviceId={id} canCapture={true} />;
}
