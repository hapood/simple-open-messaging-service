use crate::OriginMode;
use std::sync::{Arc, Mutex};

/// One immutable publication of the configured endpoints and their active selection.
/// Captures retain this value across client construction, admission, and network I/O.
#[derive(Clone, Debug)]
pub(crate) struct RouteSnapshot {
    pub(crate) active: String,
    pub(crate) primary: String,
    pub(crate) secondary: Option<String>,
    pub(crate) mode: OriginMode,
}

/// The only mutable owner of native server routing. Never hold its publication lock across I/O.
pub(crate) struct RouteConfiguration(Mutex<Arc<RouteSnapshot>>);

impl RouteConfiguration {
    pub(crate) fn new(primary: String) -> Self {
        Self(Mutex::new(Arc::new(RouteSnapshot {
            active: primary.clone(),
            primary,
            secondary: None,
            mode: OriginMode::Primary,
        })))
    }

    pub(crate) fn snapshot(&self) -> Arc<RouteSnapshot> {
        self.0.lock().expect("route configuration lock").clone()
    }

    /// Publish the entire configuration, resetting selection to its primary. Existing captures
    /// continue to own the old publication, even if the same endpoints are configured again.
    pub(crate) fn replace(&self, primary: String, secondary: Option<String>) -> bool {
        let next = Arc::new(RouteSnapshot {
            active: primary.clone(),
            primary,
            secondary,
            mode: OriginMode::Primary,
        });
        let mut current = self.0.lock().expect("route configuration lock");
        let changed = current.active != next.active;
        *current = next;
        changed
    }

    /// A probe may publish only against the exact publication it captured. Pointer identity also
    /// rejects an ABA configuration change while a probe was in flight.
    pub(crate) fn select(
        &self,
        expected: &Arc<RouteSnapshot>,
        origin: &str,
        mode: OriginMode,
    ) -> Option<bool> {
        let candidate = match mode {
            OriginMode::Primary => Some(expected.primary.as_str()),
            OriginMode::Secondary => expected.secondary.as_deref(),
        };
        if candidate != Some(origin) {
            return None;
        }
        let mut current = self.0.lock().expect("route configuration lock");
        if !Arc::ptr_eq(&current, expected) {
            return None;
        }
        let changed = current.active != origin;
        if changed || current.mode != mode {
            *current = Arc::new(RouteSnapshot {
                active: origin.to_string(),
                mode,
                ..(**expected).clone()
            });
        }
        Some(changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_probe_cannot_publish_into_a_reconfigured_server_even_after_aba() {
        let routes = RouteConfiguration::new("https://old.example".into());
        routes.replace("https://old.example".into(), Some("http://old.lan".into()));
        let before = routes.snapshot();
        routes.replace("https://new.example".into(), None);
        routes.replace(before.primary.clone(), before.secondary.clone());
        assert_eq!(
            routes.select(&before, "http://old.lan", OriginMode::Secondary),
            None
        );
        assert_eq!(routes.snapshot().active, before.primary);
    }

    #[test]
    fn selection_keeps_configuration_and_mode_coherent_and_rejects_foreign_origins() {
        let routes = RouteConfiguration::new("https://primary.example".into());
        routes.replace(
            "https://primary.example".into(),
            Some("http://secondary.lan".into()),
        );
        let before = routes.snapshot();
        assert_eq!(
            routes.select(&before, "https://foreign.example", OriginMode::Secondary),
            None
        );
        assert_eq!(
            routes.select(&before, "http://secondary.lan", OriginMode::Secondary),
            Some(true)
        );
        let after = routes.snapshot();
        assert_eq!(after.active, "http://secondary.lan");
        assert_eq!(after.mode, OriginMode::Secondary);
        assert_eq!(after.primary, before.primary);
        assert_eq!(after.secondary, before.secondary);
        assert_eq!(before.active, before.primary);
    }
}
