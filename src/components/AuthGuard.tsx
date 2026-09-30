import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuthStore } from "@/stores/authStore";
import { Trans, useTranslation } from "react-i18next";
import { type Role, roleAtLeast } from "@/lib/roles";
import { can, effectiveTier, type CapabilityId } from "@/lib/permissions";

interface AuthGuardProps {
  children: React.ReactNode;
  requiredRole?: Role;
  /**
   * Gate on a capability instead of a fixed rank, so a route follows the
   * admin-configured matrix. Checked in addition to `requiredRole`.
   */
  requiredCapability?: CapabilityId;
  /**
   * Pass when the caller holds ANY of these. For routes that host more than
   * one workflow — /wiki/:slug/edit serves both the atomic-fact panels and
   * the whole-page editor, and those are separate capabilities.
   */
  requiredAnyCapability?: CapabilityId[];
}

function StrongText({ children }: React.PropsWithChildren): JSX.Element {
  return <strong>{children}</strong>;
}

export function AuthGuard({
  children,
  requiredRole,
  requiredCapability,
  requiredAnyCapability,
}: AuthGuardProps) {
  const { t } = useTranslation();
  const { isAuthenticated, isLoading, user, permissionOverrides } =
    useAuthStore();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-muted-foreground">{t("auth.loading")}</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  const missingRole = Boolean(
    requiredRole && user && !roleAtLeast(user.role, requiredRole),
  );
  const missingCapability = Boolean(
    requiredCapability &&
      !can(user?.role, requiredCapability, permissionOverrides),
  );
  const missingAnyCapability = Boolean(
    requiredAnyCapability?.length &&
      !requiredAnyCapability.some((capability) =>
        can(user?.role, capability, permissionOverrides),
      ),
  );

  if (missingRole || missingCapability || missingAnyCapability) {
    // Name the tier the capability currently needs rather than the literal
    // capability id: the matrix is adjustable, so "you need editor" stays
    // true after an admin moves it, and "you need wiki.page.approve" doesn't
    // tell the reader anything actionable.
    const gatingCapability =
      requiredCapability ?? requiredAnyCapability?.[0] ?? null;
    const needed = gatingCapability
      ? effectiveTier(gatingCapability, permissionOverrides)
      : requiredRole;

    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">
            {t("auth.accessDenied")}
          </h2>
          <p className="text-muted-foreground">
            <Trans
              i18nKey="auth.needRole"
              values={{ role: needed }}
              components={{ strong: <StrongText /> }}
            />
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
