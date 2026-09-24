export enum Event {
  // legacy events kept so existing services still compile
  URL_TRACKING = "url_tracking",
  EXCLUDED_DOMAINS_VISIT = "excluded_domains_visit",
  INSTALLED_EXTENSIONS = "installed_extensions",
  USER_MAPPING = "user_mapping",
  SCREEN_ANALYSIS = "screen_analysis",
  ADS_RATED = "ads_rated",

  // new study events
  INSTALLED = "installed",
  PAGE_VIEW = "page_view",
  CONTENT_LOADED = "content_loaded",
  HEARTBEAT = "heartbeat",
  NAV_COMMITTED = "nav_committed",
  ASSISTANT_HIDDEN = "assistant_hidden",
  // Manipulation check for the chat arms: the AI assistant's entry point was present on the
  // page. Lets analysis tell "chose not to use it" apart from "Amazon never offered it" for a
  // chat_no_guide participant with zero assistant interactions. Raw event is DROP_EVENTS'd -
  // the signal lives in session_summary.assistant_available.
  ASSISTANT_AVAILABLE = "assistant_available",
  // Classic-arm diagnostic: hideAssistantIfNeeded() ran but the assistant entry point/panel was
  // still visible right after - see checkAssistantLeak() in Content.ts. Kept as a raw event (not
  // DROP_EVENTS'd) since it's rare and each occurrence's detail (which selector, iframe or not)
  // is the point, not just a per-session count.
  ASSISTANT_LEAK_DETECTED = "assistant_leak_detected",
  PRODUCT_PAGE_VIEW = "product_page_view",
  ADD_TO_CART_CLICK = "add_to_cart_click",
  CART_REMOVE = "cart_remove",
  CART_SUBTOTAL = "cart_subtotal",
  TAB_DWELL = "tab_dwell",
  ASSISTANT_TEXT = "assistant_text",
  SEARCH_SUBMITTED = "search_submitted",
  SESSION_SUMMARY = "session_summary",
  FILTER_USED = "filter_used",
  BACKTRACK_NAVIGATION = "backtrack_navigation",
  DECISION_MADE = "decision_made",
  PRODUCT_RESULT_CLICK = "product_result_click",
  CART_BASELINE_COUNT = "cart_baseline_count",
  CART_SNAPSHOT = "cart_snapshot",
  AMAZON_LOGIN_CONFIRMED = "amazon_login_confirmed",

  // Control/vulnerability evidence - fired at the exact points where the failure-mode fixes in
  // this codebase (Qualtrics failing to hand off PROLIFIC_PID, a participant not signed into
  // Amazon) actually engage, so their real-world frequency and whether they resolve correctly
  // is queryable after the fact instead of only visible in a console log nobody is watching
  // during a live, unsupervised Prolific session.
  AUTO_REGISTRATION_FAILED = "auto_registration_failed",
  REGISTRATION_COMPLETED = "registration_completed",
  AMAZON_LOGIN_BLOCK_SHOWN = "amazon_login_block_shown",
  AMAZON_LOGIN_BLOCKED_AT_CART = "amazon_login_blocked_at_cart",
  PRE_TASK_ACTIVITY_SUPPRESSED = "pre_task_activity_suppressed",
}
