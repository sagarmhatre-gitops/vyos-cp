import { useParams } from "react-router-dom";
import { DeviceHeader } from "../components/DeviceHeader";
import { LiveConfigTab } from "./LiveConfigTab";

/**
 * Route wrapper for the Live Config tab.
 * Reads :id from the URL and renders the tab inside the device shell.
 *
 * The <DeviceHeader/> wrapper matches what every other device tab page does
 * (see Interfaces.tsx, NAT.tsx). Without it the device name, status, and
 * tab navigation row are missing on this route.
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
    return (
        <>
            <DeviceHeader />
            <LiveConfigTab deviceId={id} canCapture={true} />
        </>
    );
}
