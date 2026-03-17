# Changelog

## 0.1.2

### Fixed

- Orchestrate uses send/send-key instead of send-panel
- `drag_surface_to_split` direction passed as positional arg with fallback
- `clear_notifications` tracks full lines so clear actually works
- Resolve 5 remaining test failures (round 2)
- `cmux_browser_screenshot` falls back to screencapture when native snapshot fails
- `cmux_session_reconcile` compares by surface_ref so duplicate CLI types detect drift
- `cmux_send_key_all` uses send-panel to target all surfaces, not just focused
- Use send-panel/send-key-panel for AI CLI surfaces; remove auto-save from safeMut
- `cmux_list_notifications` filters out read notifications
- `cmux_send_panel` resolves pane refs to surface refs before sending
