(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const state = {
    api: localStorage.getItem("usthing-api-base") || defaultApiBase(),
    identity: localStorage.getItem("usthing-api-identity") || "alice",
    terms: [],
    plans: [],
    selectedPlan: null,
    currentOffering: null,
    currentEvents: [],
    editingEvent: null,
    apiDocument: null,
    apiOperations: [],
    courses: [],
    courseCursor: null,
    planCursor: null,
    eventCursor: null,
    watchCursor: null,
    notifications: [],
    notificationCursor: null,
    discoveryCursor: null,
    quotaCursor: null,
  };

  function defaultApiBase() {
    return window.location.hostname && window.location.hostname !== "localhost"
      ? `${window.location.protocol}//${window.location.hostname}:3000`
      : "http://localhost:3000";
  }

  function updateApiDocsLink() {
    $("#open-api-docs").href = `${state.api.replace(/\/$/, "")}/documentation`;
  }

  function authHeaders(publicRoute = false) {
    const headers = { Accept: "application/json" };
    if (publicRoute) return headers;
    const bearer =
      state.identity === "alice"
        ? "alice-dev-token"
        : state.identity === "bob"
          ? "bob-dev-token"
          : $("#custom-token").value.trim();
    if (!bearer) throw new Error("Enter a Bearer token first.");
    headers.Authorization = `Bearer ${bearer}`;
    return headers;
  }

  function idempotencyKey() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  }

  async function apiRequest(path, options = {}) {
    const headers = {
      ...authHeaders(options.public),
      ...(options.headers || {}),
    };
    if (options.body !== undefined && !headers["Content-Type"])
      headers["Content-Type"] = "application/json";
    const started = performance.now();
    let response;
    try {
      response = await fetch(`${state.api.replace(/\/$/, "")}${path}`, {
        method: options.method || "GET",
        headers,
        ...(options.body === undefined
          ? {}
          : {
              body:
                typeof options.body === "string"
                  ? options.body
                  : JSON.stringify(options.body),
            }),
      });
    } catch (error) {
      renderRaw("Network error", { error: error.message });
      throw new Error(
        "Could not reach the API. Check the address and server status.",
      );
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const elapsed = Math.round(performance.now() - started);
    renderRaw(
      `${response.status} ${response.statusText} · ${elapsed} ms`,
      data,
    );
    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
          data?.message ||
          `Request failed (${response.status}).`,
      );
    }
    return { data, headers: response.headers };
  }

  function renderRaw(status, data) {
    $("#raw-status").textContent = status;
    $("#raw-output").textContent =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }

  function toast(message, isError = false) {
    const item = document.createElement("div");
    item.className = `toast${isError ? " error" : ""}`;
    item.textContent = message;
    $("#toast-region").append(item);
    setTimeout(() => item.remove(), 3500);
  }

  function setBusy(button, busy, label = "Working...") {
    if (!button) return;
    if (busy) {
      if (!button.dataset.idleLabel)
        button.dataset.idleLabel = button.textContent;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = label;
    } else {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (button.dataset.idleLabel)
        button.textContent = button.dataset.idleLabel;
    }
  }

  function bindBusy(selector, handler, label = "Working...") {
    const button = $(selector);
    if (!button) return;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      setBusy(button, true, label);
      try {
        await handler();
      } catch (error) {
        toast(error.message || "Request failed.", true);
      } finally {
        setBusy(button, false);
      }
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  function renderPageNav(selector, page, onNext) {
    const target = $(selector);
    if (!target) return;
    target.replaceChildren();
    if (!page?.hasMore || !page.nextCursor) return;
    const button = document.createElement("button");
    button.className = "button secondary small";
    button.type = "button";
    button.textContent = "Load more";
    button.addEventListener("click", async () => {
      setBusy(button, true, "Loading...");
      try {
        await onNext(page.nextCursor);
      } finally {
        setBusy(button, false);
      }
    });
    target.append(button);
  }

  // Diagnostics are emitted one entry per rejected candidate bundle, so a
  // course with several unusable sections yields several entries that would
  // otherwise read as identical lines. Group them by course and count; the
  // per-bundle detail stays available but folded away.
  const DIAGNOSTIC_REASONS = {
    bundle_full: "no remaining seats",
    quota_unknown: "no quota data",
    course_not_offered: "not offered this term",
    lock_conflict: "locked sections unavailable",
    unknown_credits: "credits unknown",
    no_feasible_option: "no feasible option",
  };

  function renderDiagnostics(items) {
    const byCourse = new Map();
    for (const item of items) {
      const key = item.courseCode || "This request";
      const reasons = byCourse.get(key) ?? new Map();
      const reason = DIAGNOSTIC_REASONS[item.code] || item.code;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      byCourse.set(key, reasons);
    }
    const summary = [...byCourse.entries()]
      .map(([course, reasons]) => {
        const parts = [...reasons.entries()]
          .map(([reason, count]) => `${count} \u00d7 ${reason}`)
          .join(", ");
        return `<li><strong>${escapeHtml(course)}</strong><span>${escapeHtml(parts)}</span></li>`;
      })
      .join("");
    const detail = items
      .map((item) => `<p>${escapeHtml(item.message)}</p>`)
      .join("");
    return `<details class="diagnostics"><summary>Skipped bundles (${items.length})</summary><ul class="diagnostics-summary">${summary}</ul><div class="diagnostics-detail">${detail}</div></details>`;
  }

  function setHealth(online) {
    const badge = $("#health-state");
    badge.textContent = online ? "Connected" : "Offline";
    badge.className = `status ${online ? "online" : "offline"}`;
  }

  async function checkHealth() {
    try {
      await apiRequest("/health", { public: true });
      setHealth(true);
    } catch (error) {
      setHealth(false);
      toast(error.message, true);
    }
  }

  async function loadTerms() {
    try {
      const response = await apiRequest("/terms?limit=100");
      state.terms = response.data?.items || [];
      const options = state.terms
        .map(
          (term) =>
            `<option value="${escapeHtml(term.termCode)}">${escapeHtml(term.displayName || term.termCode)} · ${escapeHtml(term.termCode)}</option>`,
        )
        .join("");
      [
        "#academic-term",
        "#calendar-term",
        "#plan-term",
        "#watch-term",
        "#common-core-term",
      ].forEach((selector) => {
        $(selector).innerHTML =
          options || '<option value="">No active terms</option>';
      });
      const current = state.terms.find((term) => term.isCurrent)?.termCode;
      if (current) {
        [
          "#academic-term",
          "#calendar-term",
          "#plan-term",
          "#watch-term",
          "#common-core-term",
        ].forEach((selector) => {
          $(selector).value = current;
        });
      }
      $("#common-core-year").value = String(new Date().getFullYear() - 1);
      await refreshPlans();
    } catch (error) {
      [
        "#academic-term",
        "#calendar-term",
        "#plan-term",
        "#watch-term",
        "#common-core-term",
      ].forEach((selector) => {
        $(selector).innerHTML = '<option value="">API unavailable</option>';
      });
      toast(error.message, true);
    }
  }

  function currentTerm() {
    return $("#academic-term").value || "";
  }

  async function searchCourses(cursor = null) {
    const search = $("#course-search").value.trim();
    const subject = $("#course-subject").value.trim();
    const catalogNumber = $("#course-catalog-number").value.trim();
    if (!search && !subject && !catalogNumber) {
      toast("Enter a search term, subject, or catalog number.", true);
      return;
    }
    const term = currentTerm();
    if (!term) {
      toast("Select a term with an active catalog.", true);
      return;
    }
    $("#course-results").innerHTML = '<div class="loading">Searching...</div>';
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      if (search) query.set("search", search);
      if (subject) query.set("subject", subject);
      if (catalogNumber) query.set("catalogNumber", catalogNumber);
      const response = await apiRequest(
        `/terms/${encodeURIComponent(term)}/courses?${query}`,
      );
      const items = response.data?.items || [];
      state.courseCursor = response.data?.page?.nextCursor || null;
      state.courses = cursor ? [...state.courses, ...items] : items;
      renderCourseResults(state.courses, response.data?.page);
    } catch (error) {
      $("#course-results").innerHTML =
        `<div class="empty error-text">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  function renderCourseResults(items, page = {}) {
    $("#course-count").textContent =
      `${items.length} result${items.length === 1 ? "" : "s"}`;
    $("#course-results").innerHTML = items.length
      ? items
          .map(
            (course, index) => `
        <button class="course-row" data-course-index="${index}" type="button">
          <span><strong>${escapeHtml(course.courseCode)}</strong><small>${escapeHtml(course.title)}</small></span>
          <span class="course-meta">${escapeHtml(course.sectionCount)} sections</span>
        </button>`,
          )
          .join("")
      : '<div class="empty">No matching courses.</div>';
    $$("[data-course-index]").forEach((button) => {
      button.addEventListener("click", () =>
        showOffering(items[Number(button.dataset.courseIndex)]),
      );
    });
    renderPageNav("#course-pagination", page, (nextCursor) =>
      searchCourses(nextCursor),
    );
  }

  async function showOffering(course) {
    if (!course?.offeringId) {
      toast("This course has no active offering.", true);
      return;
    }
    state.currentOffering = course;
    $("#offering-title").textContent =
      `${course.courseCode} · ${course.title || ""}`;
    $("#copy-offering").disabled = false;
    $("#offering-detail").innerHTML =
      '<div class="loading">Loading sections and bundles...</div>';
    try {
      const [offeringResult, bundleResult] = await Promise.all([
        apiRequest(`/offerings/${encodeURIComponent(course.offeringId)}`),
        apiRequest(
          `/offerings/${encodeURIComponent(course.offeringId)}/bundles`,
        ),
      ]);
      const offering = offeringResult.data?.data;
      const sections = offering?.sections || [];
      const bundles = bundleResult.data?.items || [];
      const binding = offering?.bundleAvailability === "unverified_binding";
      $("#offering-detail").innerHTML = `
        <div class="detail-head">
          <span>${sections.length} sections</span><span>${bundles.length} selectable combinations</span>
          <button class="link-button" id="copy-course-offering" type="button">Copy offering ID</button>
        </div>
        ${binding ? '<p class="notice">Section binding is unverified; combinations are unavailable.</p>' : ""}
        <h3 class="subheading">Selectable combinations</h3>
        <div class="bundle-list">${
          bundles.length
            ? bundles
                .map(
                  (bundle, index) => `
          <div class="bundle-row">
            <span><strong>${escapeHtml((bundle.sectionLabels || []).join(" + "))}</strong><small>${escapeHtml(bundle.source || "derived")}${bundle.bindingGroup ? ` · group ${escapeHtml(bundle.bindingGroup)}` : ""}</small></span>
            <button class="button small secondary" data-add-bundle="${index}" type="button">Add to plan</button>
          </div>`,
                )
                .join("")
            : '<div class="empty compact-empty">No selectable bundles.</div>'
        }</div>
        <h3 class="subheading">Sections</h3>
        <div class="section-list">${sections
          .map(
            (section, index) => `
          <div class="section-row">
            <span><strong>${escapeHtml(section.sectionCode || section.classNbr)}</strong><small>${escapeHtml(section.componentType || "")} · ${escapeHtml((section.instructors || []).join(", ") || "Instructor not listed")}</small></span>
            <span class="seat">${escapeHtml(section.classNbr)}</span>
            <div class="row-actions section-actions">
              <button class="link-button" data-section-action="quota" data-section-index="${index}" type="button">Quota</button>
              <button class="link-button" data-section-action="watch" data-section-index="${index}" type="button">Watch</button>
              <button class="link-button" data-section-action="discovery" data-section-index="${index}" type="button">Classmates</button>
              <button class="link-button" data-section-action="copy" data-section-index="${index}" type="button">Copy ID</button>
            </div>
          </div>`,
          )
          .join("")}</div>`;
      $("#copy-course-offering").addEventListener("click", () =>
        copyText(course.offeringId, "Offering ID copied."),
      );
      $$("[data-add-bundle]").forEach((button) => {
        button.addEventListener("click", async () => {
          setBusy(button, true, "Adding...");
          try {
            await addBundleToPlan(bundles[Number(button.dataset.addBundle)]);
          } finally {
            setBusy(button, false);
          }
        });
      });
      $$(`[data-section-action]`).forEach((button) => {
        button.addEventListener("click", () => {
          const section = sections[Number(button.dataset.sectionIndex)];
          if (!section?.sectionId)
            return toast("This section has no ID.", true);
          const action = button.dataset.sectionAction;
          if (action === "copy") {
            copyText(section.sectionId, "Section ID copied.");
            return;
          }
          if (action === "quota") {
            $("#quota-section").value = section.sectionId;
            switchTab("developer");
            $("#quota-check").click();
            return;
          }
          if (action === "watch") {
            $("#watch-target-type").value = "section";
            $("#watch-target-id").value = section.sectionId;
            if (
              [...$("#watch-term").options].some(
                (option) => option.value === course.termCode,
              )
            )
              $("#watch-term").value = course.termCode;
            switchTab("watching");
            toast("Section ID ready for watching.");
            return;
          }
          $("#discovery-section").value = section.sectionId;
          switchTab("watching");
          toast("Section ID ready for finding classmates.");
        });
      });
    } catch (error) {
      $("#offering-detail").innerHTML =
        `<div class="empty error-text">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  async function addBundleToPlan(bundle) {
    const plan = state.selectedPlan;
    if (!plan) {
      switchTab("plan");
      toast("Create or select a plan first.");
      return;
    }
    if (plan.termCode !== state.currentOffering?.termCode) {
      switchTab("plan");
      toast("Select a plan for the same term as the course.");
      return;
    }
    try {
      const response = await apiRequest(
        `/plans/${encodeURIComponent(plan.id)}/items`,
        {
          method: "POST",
          headers: { "If-Match": `"${plan.revision}"` },
          body: {
            offeringId: bundle.offeringId,
            bundleId: bundle.bundleId,
            status: "alternative",
          },
        },
      );
      state.selectedPlan = response.data?.data || state.selectedPlan;
      toast("Bundle added as an alternative.");
      await loadSelectedPlan();
      await refreshPlans();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function copyText(text, success = "Copied.") {
    try {
      await navigator.clipboard.writeText(text);
      toast(success);
    } catch {
      toast("Clipboard access is unavailable.", true);
    }
  }

  function localDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function setDateDefaults() {
    const today = new Date();
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + 90);
    const nextDay = new Date(today);
    nextDay.setDate(nextDay.getDate() + 1);
    $("#calendar-from").value ||= localDate(today);
    $("#calendar-to").value ||= localDate(horizon);
    $("#event-date").value ||= localDate(today);
    $("#event-until").value ||= localDate(horizon);
    $("#event-end-date").value ||= localDate(nextDay);
  }

  function termWindow() {
    const start = $("#calendar-from").value;
    const end = $("#calendar-to").value;
    if (!start || !end || start >= end)
      throw new Error("Choose a valid date range.");
    return { start, end };
  }

  async function loadCalendar(conflicts = false) {
    try {
      const { start, end } = termWindow();
      const term = $("#calendar-term").value;
      const path = conflicts ? "/calendar/conflicts" : "/calendar";
      const query = new URLSearchParams({
        from: start,
        to: end,
        termCode: term,
      });
      if ($("#calendar-plan").value)
        query.set("planId", $("#calendar-plan").value);
      const response = await apiRequest(path + "?" + query);
      const data = response.data?.data || response.data;
      const rows = conflicts
        ? [
            ...(data?.blocking || []),
            ...(data?.informational || data?.items || []),
          ]
        : data?.items || [];
      $("#calendar-results").innerHTML = rows.length
        ? renderCalendarAgenda(rows, conflicts)
        : '<div class="empty">No classes or events in this date range.</div>';
    } catch (error) {
      $("#calendar-results").innerHTML =
        `<div class="empty error-text">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  // Calendar rows arrive flat and sorted-ish. Reading a timetable means reading
  // it by day, so group them and render an agenda instead of one long list.
  function renderCalendarAgenda(rows, conflicts) {
    const summary = `<div class="result-summary"><strong>${conflicts ? "Conflicts" : "Classes and events"}</strong><span>${rows.length}</span></div>`;

    if (conflicts) {
      return `${summary}<div class="calendar-list">${rows.map((row) => renderCalendarRow(row, conflicts)).join("")}</div>`;
    }

    const days = new Map();
    rows.forEach((row) => {
      // localStartsAt looks like 2026-09-28T21:30:00+08:00[Asia/Hong_Kong];
      // the leading date is the local one, which is what a student reads.
      const key =
        (row.localStartsAt || row.localEndsAt || row.startsAt || "").slice(
          0,
          10,
        ) ||
        row.startDate ||
        "Unscheduled";
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(row);
    });

    const todayKey = localDate(new Date());
    const ordered = [...days.entries()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    );

    const grid = ordered
      .map(([day, items]) => {
        const label = day === "Unscheduled" ? day : formatAgendaDay(day);
        const classes = day === todayKey ? "week-day is-today" : "week-day";
        const body = items
          .map((row) => {
            const kind = row.eventType || row.source || "other";
            const time = row.allDay
              ? "All day"
              : `${clockTime(row.localStartsAt || row.startsAt)} – ${clockTime(row.localEndsAt || row.endsAt)}`;
            const meta = [row.location, row.source === "plan" ? "Plan" : ""]
              .filter(Boolean)
              .join(" · ");
            return `<div class="agenda-item" data-kind="${escapeHtml(kind)}"><time>${escapeHtml(time)}</time><strong>${escapeHtml(row.title || "Calendar item")}</strong>${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</div>`;
          })
          .join("");
        return `<div class="${classes}"><div class="week-day-label">${escapeHtml(label)}</div><div class="week-day-items">${body}</div></div>`;
      })
      .join("");

    return `${summary}<div class="week-grid">${grid}</div>`;
  }

  function formatAgendaDay(day) {
    const parsed = new Date(`${day}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return day;
    return parsed.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  // "2026-09-28T21:30:00+08:00[Asia/Hong_Kong]" -> "21:30"
  function clockTime(value) {
    const match = /T(\d{2}:\d{2})/.exec(value || "");
    return match ? match[1] : "";
  }

  function renderCalendarRow(row, conflicts) {
    if (conflicts) {
      return `<div class="calendar-row"><span class="date-cell">${escapeHtml(row.localDate || "")}</span><div><strong>${escapeHtml(row.severity || "Conflict")} · ${escapeHtml(row.kind || "")}</strong><small>${escapeHtml(row.startTime || "All day")} – ${escapeHtml(row.endTime || "")}</small></div></div>`;
    }
    return `<div class="calendar-row"><span class="date-cell">${escapeHtml(row.localStartsAt || row.startsAt || row.startDate || "")}</span><div><strong>${escapeHtml(row.title || "Calendar item")}</strong><small>${escapeHtml(row.localEndsAt || row.endsAt || row.endDate || "")} · ${escapeHtml(row.source || "")}</small></div></div>`;
  }

  async function loadCalendarBanner() {
    try {
      const query = new URLSearchParams();
      if ($("#calendar-term").value)
        query.set("termCode", $("#calendar-term").value);
      if ($("#calendar-plan").value)
        query.set("planId", $("#calendar-plan").value);
      const response = await apiRequest(
        "/calendar/banner" + (query.size ? "?" + query : ""),
      );
      const data = response.data?.data || response.data;
      const item = data.item;
      $("#calendar-banner-result").innerHTML =
        '<div class="result-summary"><strong>' +
        escapeHtml(data.state || "free") +
        "</strong><span>Evaluated " +
        escapeHtml(data.evaluatedAt || "") +
        '</span></div><p class="small-note">' +
        (item
          ? escapeHtml(item.title) +
            " · " +
            escapeHtml(item.localStartsAt || item.startsAt || "") +
            " · " +
            escapeHtml(data.minutesRemaining ?? data.minutesUntilStart ?? "—") +
            " min"
          : "No current or upcoming event.") +
        "</p>";
    } catch (error) {
      $("#calendar-banner-result").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
      toast(error.message, true);
    }
  }

  async function exportCalendar() {
    try {
      const { start, end } = termWindow();
      const query = new URLSearchParams({ from: start, to: end });
      if ($("#calendar-term").value)
        query.set("termCode", $("#calendar-term").value);
      if ($("#calendar-plan").value)
        query.set("planId", $("#calendar-plan").value);
      const response = await fetch(
        state.api.replace(/\/$/, "") + "/events.ics?" + query,
        { headers: authHeaders() },
      );
      if (!response.ok) {
        const body = await response.text();
        let message = body;
        try {
          message = JSON.parse(body)?.error?.message || body;
        } catch {}
        throw new Error(message || "Export failed (" + response.status + ").");
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "usthing-calendar.ics";
      link.click();
      URL.revokeObjectURL(url);
      toast("Calendar exported.");
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function refreshPlans(cursor = null) {
    const term = $("#plan-term").value;
    if (!term) return;
    try {
      const query = new URLSearchParams({ termCode: term, limit: "50" });
      const status = $("#plan-filter-status")?.value;
      if (status) query.set("status", status);
      if (cursor) query.set("cursor", cursor);
      const response = await apiRequest(`/plans?${query}`);
      const planItems = response.data?.items || [];
      state.plans = cursor ? [...state.plans, ...planItems] : planItems;
      state.planCursor = response.data?.page?.nextCursor || null;
      renderPageNav("#plan-pagination", response.data?.page, (nextCursor) =>
        refreshPlans(nextCursor),
      );
      const calendarPlan = $("#calendar-plan");
      const selectedCalendarPlan = calendarPlan.value;
      calendarPlan.innerHTML =
        '<option value="">All plans</option>' +
        state.plans
          .map(
            (plan) =>
              '<option value="' +
              escapeHtml(plan.id) +
              '">' +
              escapeHtml(plan.name) +
              " · " +
              escapeHtml(plan.status) +
              "</option>",
          )
          .join("");
      if (state.plans.some((plan) => plan.id === selectedCalendarPlan))
        calendarPlan.value = selectedCalendarPlan;
      const select = $("#plan-select");
      const previous = select.value;
      select.innerHTML = state.plans.length
        ? state.plans
            .map(
              (plan) =>
                `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)} · ${escapeHtml(plan.status)}</option>`,
            )
            .join("")
        : '<option value="">No plans</option>';
      const nextId = state.plans.some((plan) => plan.id === previous)
        ? previous
        : state.plans[0]?.id;
      select.value = nextId || "";
      syncPlanContext();
      await loadSelectedPlan();
    } catch (error) {
      toast(error.message, true);
    }
  }

  // The shared plan strip is only meaningful once a plan exists, and only
  // once one is selected. Keep it out of the way otherwise.
  function syncPlanContext() {
    const bar = $("#plan-context");
    if (!bar) return;
    const hasPlans = state.plans.length > 0;
    bar.hidden = !hasPlans;
  }

  // The plan summary is a run-on string like
  // "Fall timetable · draft · revision 3 · 2 items". Render it as labelled
  // metrics instead: a wall of small facts is easier to scan than a sentence,
  // and the status becomes a chip rather than another word.
  function renderPlanSummary(plan) {
    const target = $("#plan-summary");
    if (!plan) {
      target.textContent = "Select a plan to add courses to it.";
      return;
    }
    const labels = [
      ["Plan", plan.name],
      ["Status", plan.status, "chip"],
      ["Revision", `r${plan.revision}`],
      ["Courses", String(plan.items?.length ?? 0)],
    ];
    target.innerHTML = labels
      .map(([label, value, kind]) =>
        kind === "chip"
          ? `<span class="context-metric"><span>${escapeHtml(label)}</span><span class="metric-chip" data-status="${escapeHtml(String(value))}">${escapeHtml(String(value))}</span></span>`
          : `<span class="context-metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></span>`,
      )
      .join("");
  }

  async function loadSelectedPlan() {
    const planId = $("#plan-select").value;
    if (!planId) {
      state.selectedPlan = null;
      renderPlanSummary(null);
      $("#plan-items").innerHTML =
        '<div class="empty compact-empty">Select a plan to view its courses.</div>';
      $("#plan-item-count").textContent = "0 items";
      $("#plan-actions").hidden = true;
      return;
    }
    try {
      const response = await apiRequest(`/plans/${encodeURIComponent(planId)}`);
      state.selectedPlan = response.data?.data || null;
      const plan = state.selectedPlan;
      renderPlanSummary(plan);
      renderPlanItems(plan);
      renderPlanActions(plan);
      $("#plan-edit-fields").hidden = !plan || plan.status === "archived";
      if (plan) {
        $("#plan-edit-name").value = plan.name || "";
        $("#plan-edit-description").value = plan.description || "";
      }
      await refreshShares();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function renderPlanActions(plan) {
    const actions = $("#plan-actions");
    actions.hidden = !plan;
    $("#activate-plan").hidden = plan?.status !== "draft";
    $("#archive-plan").hidden = !plan || plan.status === "archived";
  }

  function renderPlanItems(plan) {
    const items = plan?.items || [];
    $("#plan-item-count").textContent =
      `${items.length} item${items.length === 1 ? "" : "s"}`;
    $("#plan-items").innerHTML = items.length
      ? items
          .map(
            (item, index) => `
        <article class="plan-item">
          <div><strong>${escapeHtml(item.course?.courseCode || item.courseCodeSnapshot || "Course")}</strong><span class="badge">${escapeHtml(item.status)}</span><small>${escapeHtml((item.bundle?.sectionLabels || item.sectionLabelsSnapshot || []).join(" + ") || "Sections unavailable")}${item.note ? ` · ${escapeHtml(item.note)}` : ""}</small></div>
          <div class="plan-item-actions"><button class="link-button" data-item-status="${index}" type="button" ${plan.status === "archived" ? "disabled" : ""}>${item.status === "selected" ? "Make alternative" : item.status === "rejected" ? "Restore" : "Select"}</button><button class="link-button danger-link" data-item-delete="${index}" type="button" ${plan.status === "archived" ? "disabled" : ""}>Remove</button></div>
        </article>`,
          )
          .join("")
      : '<div class="empty compact-empty">No courses in this plan.</div>';
    $$("#plan-items .plan-item").forEach((row, index) => {
      const item = items[index];
      const actions = row.querySelector(".plan-item-actions");
      if (!item || !actions) return;
      actions.replaceChildren();
      const disabled = plan.status === "archived";
      const status = document.createElement("select");
      status.setAttribute("aria-label", "Course status");
      status.disabled = disabled;
      for (const value of ["selected", "alternative", "rejected"]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        option.selected = item.status === value;
        status.append(option);
      }
      status.addEventListener("change", () =>
        patchPlanItem(item.itemId, { status: status.value }),
      );
      const note = document.createElement("input");
      note.type = "text";
      note.value = item.note || "";
      note.placeholder = "Course note";
      note.setAttribute("aria-label", "Course note");
      note.disabled = disabled;
      const colorEnabled = document.createElement("input");
      colorEnabled.type = "checkbox";
      colorEnabled.checked = Boolean(item.colorOverride);
      colorEnabled.disabled = disabled;
      colorEnabled.setAttribute("aria-label", "Use color override");
      const color = document.createElement("input");
      color.type = "color";
      color.value = /^#[0-9a-f]{6}$/i.test(item.colorOverride || "")
        ? item.colorOverride
        : "#176b62";
      color.disabled = disabled || !colorEnabled.checked;
      color.setAttribute("aria-label", "Course color");
      colorEnabled.addEventListener("change", () => {
        color.disabled = disabled || !colorEnabled.checked;
      });
      const save = document.createElement("button");
      save.className = "link-button";
      save.type = "button";
      save.textContent = "Save";
      save.disabled = disabled;
      save.addEventListener("click", () =>
        patchPlanItem(item.itemId, {
          note: note.value.trim() || null,
          colorOverride: colorEnabled.checked ? color.value : null,
        }),
      );
      const remove = document.createElement("button");
      remove.className = "link-button danger-link";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.disabled = disabled;
      remove.addEventListener("click", () => removePlanItem(item.itemId));
      actions.append(status, note, colorEnabled, color, save, remove);
    });
    $$("[data-item-status]").forEach((button) => {
      button.addEventListener("click", async () => {
        const item = items[Number(button.dataset.itemStatus)];
        const status = item.status === "selected" ? "alternative" : "selected";
        await patchPlanItem(item.itemId, { status });
      });
    });
    $$("[data-item-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const item = items[Number(button.dataset.itemDelete)];
        await removePlanItem(item.itemId);
      });
    });
  }

  async function patchPlanItem(itemId, body) {
    const plan = state.selectedPlan;
    if (!plan) return;
    try {
      const response = await apiRequest(
        `/plans/${encodeURIComponent(plan.id)}/items/${encodeURIComponent(itemId)}`,
        {
          method: "PATCH",
          headers: { "If-Match": `"${plan.revision}"` },
          body,
        },
      );
      state.selectedPlan = response.data?.data || plan;
      toast("Plan course updated.");
      await loadSelectedPlan();
      await refreshPlans();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function removePlanItem(itemId) {
    const plan = state.selectedPlan;
    if (!plan) return;
    try {
      const response = await apiRequest(
        `/plans/${encodeURIComponent(plan.id)}/items/${encodeURIComponent(itemId)}`,
        {
          method: "DELETE",
          headers: { "If-Match": `"${plan.revision}"` },
        },
      );
      state.selectedPlan = response.data?.data || plan;
      toast("Course removed from plan.");
      await loadSelectedPlan();
      await refreshPlans();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function changePlanStatus(status) {
    const plan = state.selectedPlan;
    if (!plan) return;
    try {
      const response = await apiRequest(
        `/plans/${encodeURIComponent(plan.id)}`,
        {
          method: "PATCH",
          headers: { "If-Match": `"${plan.revision}"` },
          body: { status },
        },
      );
      state.selectedPlan = response.data?.data || plan;
      toast(status === "active" ? "Plan activated." : "Plan archived.");
      await loadSelectedPlan();
      await refreshPlans();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function savePlanDetails() {
    const plan = state.selectedPlan;
    if (!plan || plan.status === "archived") return;
    try {
      await apiRequest("/plans/" + encodeURIComponent(plan.id), {
        method: "PATCH",
        headers: { "If-Match": '"' + plan.revision + '"' },
        body: {
          name: $("#plan-edit-name").value.trim(),
          description: $("#plan-edit-description").value.trim() || null,
        },
      });
      toast("Plan details saved.");
      await refreshPlans();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function refreshShares() {
    const plan = state.selectedPlan;
    if (!plan) {
      $("#share-list").innerHTML =
        '<div class="empty compact-empty">Select a plan to view its shares.</div>';
      return;
    }
    try {
      const response = await apiRequest(
        "/plans/" + encodeURIComponent(plan.id) + "/shares",
      );
      const rows = response.data?.items || [];
      $("#share-list").innerHTML = rows.length
        ? rows
            .map(
              (share, index) =>
                '<div class="item-row"><div><strong>Share ' +
                escapeHtml(index + 1) +
                "</strong><small>Expires " +
                escapeHtml(share.expiresAt) +
                (share.revokedAt ? " · revoked" : "") +
                " · revision " +
                escapeHtml(share.snapshotVersion) +
                '</small></div><div class="row-actions">' +
                (share.revokedAt
                  ? ""
                  : '<button class="link-button danger-link" data-revoke-share="' +
                    escapeHtml(share.shareId) +
                    '" type="button">Revoke</button>') +
                "</div></div>",
            )
            .join("")
        : '<div class="empty compact-empty">No share links.</div>';
      $$("[data-revoke-share]").forEach((button) => {
        button.addEventListener("click", () =>
          revokeShare(button.dataset.revokeShare),
        );
      });
    } catch (error) {
      $("#share-list").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
    }
  }

  async function createShare() {
    const plan = state.selectedPlan;
    if (!plan) return toast("Select a plan first.", true);
    const seconds = numberField("#share-expiry");
    try {
      const response = await apiRequest(
        "/plans/" + encodeURIComponent(plan.id) + "/shares",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: seconds === undefined ? {} : { expiresInSeconds: seconds },
        },
      );
      const share = response.data?.data || response.data;
      const link =
        state.api.replace(/\/$/, "") +
        "/shared-plans/" +
        encodeURIComponent(share.shareToken);
      $("#share-result").innerHTML =
        '<a href="' +
        escapeHtml(link) +
        '" target="_blank" rel="noreferrer">Open shared plan</a> ' +
        '<button class="link-button" id="copy-share-link" type="button">Copy link</button><p class="small-note">Expires ' +
        escapeHtml(share.expiresAt) +
        "</p>";
      $("#copy-share-link").addEventListener("click", () =>
        copyText(link, "Share link copied."),
      );
      await refreshShares();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function revokeShare(shareId) {
    const plan = state.selectedPlan;
    if (!plan) return;
    try {
      await apiRequest(
        "/plans/" +
          encodeURIComponent(plan.id) +
          "/shares/" +
          encodeURIComponent(shareId),
        { method: "DELETE" },
      );
      toast("Share revoked.");
      await refreshShares();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function readSharedPlan() {
    const token = $("#shared-plan-token").value.trim();
    if (!token) return toast("Paste a share token first.", true);
    try {
      const response = await apiRequest(
        "/shared-plans/" + encodeURIComponent(token),
        { public: true },
      );
      const data = response.data?.data || response.data;
      const items = data?.selectedCourses || [];
      $("#shared-plan-result").innerHTML =
        '<div class="result-summary"><strong>' +
        escapeHtml(data.displayLabel || "Shared plan") +
        "</strong><span>" +
        escapeHtml(data.termSummary || "") +
        " · " +
        items.length +
        " courses</span></div>" +
        (items.length
          ? '<div class="list">' +
            items
              .map(
                (item) =>
                  '<div class="item-row"><div><strong>' +
                  escapeHtml(item.courseCode || "Course") +
                  "</strong><small>" +
                  escapeHtml((item.sectionLabels || []).join(" + ")) +
                  "</small></div></div>",
              )
              .join("") +
            "</div>"
          : '<p class="small-note">No courses in this snapshot.</p>');
    } catch (error) {
      $("#shared-plan-result").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
      toast(error.message, true);
    }
  }

  function parseJsonField(selector, fallback = []) {
    const value = $(selector).value.trim();
    if (!value) return fallback;
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed))
      throw new Error(selector + " must contain a JSON array.");
    return parsed;
  }

  async function runRecommendations() {
    const plan = state.selectedPlan;
    const targetCourseId = $("#recommend-course").value.trim().toUpperCase();
    if (!plan) return toast("Create or select a plan first.", true);
    if (!targetCourseId) return toast("Enter a course code.", true);
    try {
      const body = {
        targetCourseId,
        excludedCourseIds: $("#recommend-excluded")
          .value.split(/[,\s]+/)
          .map((value) => value.trim().toUpperCase())
          .filter(Boolean),
        avoidWeekdays: checkedValues("#recommend-avoid-days"),
        unavailableWindows: parseJsonField("#recommend-unavailable"),
        preferredWindows: parseJsonField("#recommend-preferred"),
        allowWaitlist: $("#recommend-waitlist").checked,
        maxRecommendations: Math.max(
          1,
          Math.min(50, numberField("#recommend-limit") || 10),
        ),
        ...(numberField("#recommend-min-credits") === undefined
          ? {}
          : { minCredits: numberField("#recommend-min-credits") }),
        ...(numberField("#recommend-max-credits") === undefined
          ? {}
          : { maxCredits: numberField("#recommend-max-credits") }),
      };
      const response = await apiRequest(
        "/plans/" + encodeURIComponent(plan.id) + "/recommendations",
        { method: "POST", body },
      );
      const data = response.data?.data || response.data;
      const rows = data.items || [];
      $("#recommend-results").innerHTML = rows.length
        ? rows
            .map(
              (row, index) =>
                '<div class="item-row"><div><strong>' +
                escapeHtml(row.bundle.courseCode) +
                " · " +
                escapeHtml(row.bundle.sectionLabels.join(" + ")) +
                "</strong><small>Score " +
                escapeHtml(row.score) +
                " · " +
                escapeHtml(row.reasons.join("; ")) +
                '</small></div><button class="button small secondary" data-recommend-index="' +
                index +
                '" type="button">Add alternative</button></div>',
            )
            .join("")
        : '<div class="empty">No eligible bundles found.</div>';
      $$("[data-recommend-index]").forEach((button) => {
        button.addEventListener("click", () => {
          const bundle = rows[Number(button.dataset.recommendIndex)].bundle;
          state.currentOffering = {
            termCode: plan.termCode,
            offeringId: bundle.offeringId,
          };
          addBundleToPlan(bundle);
        });
      });
      const rejected =
        response.data?.meta?.rejected || data.meta?.rejected || [];
      if (rejected.length)
        $("#recommend-results").insertAdjacentHTML(
          "beforeend",
          '<details class="diagnostics"><summary>Rejected bundles (' +
            rejected.length +
            ')</summary><pre class="inline-json">' +
            escapeHtml(JSON.stringify(rejected, null, 2)) +
            "</pre></details>",
        );
    } catch (error) {
      $("#recommend-results").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
      toast(error.message, true);
    }
  }

  async function createPlan() {
    const termCode = $("#plan-term").value;
    if (!termCode) {
      toast("Select a term first.", true);
      return;
    }
    try {
      const response = await apiRequest("/plans", {
        method: "POST",
        body: {
          name: $("#plan-name").value.trim() || "My timetable",
          termCode,
          description: $("#plan-description").value.trim(),
        },
      });
      toast("Draft plan created.");
      await refreshPlans();
      const id = response.data?.data?.id;
      if (id) {
        $("#plan-select").value = id;
        await loadSelectedPlan();
      }
    } catch (error) {
      toast(error.message, true);
      await refreshPlans();
    }
  }

  async function runAutoPlan() {
    const plan = state.selectedPlan;
    if (!plan) {
      toast("Create or select a plan first.", true);
      return;
    }
    let groups;
    try {
      groups = parseAutoPlanGroups($("#autoplan-groups").value);
    } catch (error) {
      toast(error.message, true);
      return;
    }
    const groupedCodes = new Set(groups.flatMap((group) => group.courseCodes));
    let extraOptions = {};
    if ($("#autoplan-extra").value.trim()) {
      try {
        extraOptions = JSON.parse($("#autoplan-extra").value);
        if (
          !extraOptions ||
          typeof extraOptions !== "object" ||
          Array.isArray(extraOptions)
        )
          throw new Error("Options must be a JSON object.");
      } catch (error) {
        toast("Invalid auto-plan options: " + error.message, true);
        return;
      }
    }
    const courses = $("#autoplan-courses")
      .value.split(/[\n,\s]+/)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
      .map((courseCode) => ({
        courseCode,
        required: !groupedCodes.has(courseCode),
      }));
    for (const code of groupedCodes) {
      if (!courses.some((course) => course.courseCode === code))
        courses.push({ courseCode: code, required: false });
    }
    if (!courses.length) {
      toast("Enter at least one course code.", true);
      return;
    }
    const unavailableDays = checkedValues("#unavailable-days");
    let advancedConstraints;
    try {
      advancedConstraints = {
        protectedWindows: parseJsonField("#autoplan-protected"),
        preferredWindows: parseJsonField("#autoplan-preferred"),
        preferredInstructorNames: $("#autoplan-preferred-instructors")
          .value.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      };
      if ($("#autoplan-weights").value.trim())
        extraOptions.weights = JSON.parse($("#autoplan-weights").value);
      if ($("#autoplan-fill").value.trim())
        extraOptions.fill = JSON.parse($("#autoplan-fill").value);
    } catch (error) {
      toast("Invalid advanced auto-plan JSON: " + error.message, true);
      return;
    }
    const constraints = {
      unavailableWindows: unavailableDays.length
        ? [
            {
              weekdays: unavailableDays,
              startTime: $("#unavailable-start").value,
              endTime: $("#unavailable-end").value,
            },
          ]
        : [],
      freeWeekdays: checkedValues("#free-days"),
      ...(numberField("#autoplan-days-off") === undefined
        ? {}
        : { minDaysOff: numberField("#autoplan-days-off") }),
      ...(timeField("#autoplan-earliest")
        ? { earliestStart: timeField("#autoplan-earliest") }
        : {}),
      ...(timeField("#autoplan-latest")
        ? { latestEnd: timeField("#autoplan-latest") }
        : {}),
      ...(numberField("#autoplan-campus-days") === undefined
        ? {}
        : { maxCampusDays: numberField("#autoplan-campus-days") }),
      ...(numberField("#autoplan-daily-minutes") === undefined
        ? {}
        : { maxDailyClassMinutes: numberField("#autoplan-daily-minutes") }),
      ...(numberField("#autoplan-min-credits") === undefined
        ? {}
        : { minCredits: numberField("#autoplan-min-credits") }),
      ...(numberField("#autoplan-max-credits") === undefined
        ? {}
        : { maxCredits: numberField("#autoplan-max-credits") }),
      ...advancedConstraints,
    };
    $("#autoplan-results").innerHTML =
      '<div class="loading">Finding timetable options...</div>';
    try {
      const response = await apiRequest(
        `/plans/${encodeURIComponent(plan.id)}/auto-plans`,
        {
          method: "POST",
          body: {
            courses,
            groups,
            includeCurrentSelected: $("#autoplan-include-selected").checked,
            mode: $("#autoplan-mode").value,
            constraints,
            allowFullWaitlist: $("#autoplan-allow-waitlist").checked,
            unknownQuotaPolicy: $("#autoplan-quota-policy").value,
            resultLimit: Math.max(
              1,
              Math.min(10, Number($("#autoplan-limit").value) || 3),
            ),
            ...extraOptions,
          },
        },
      );
      const data = response.data?.data || response.data;
      const options = data?.options || [];
      $("#autoplan-results").innerHTML =
        `<div class="result-summary"><strong>${escapeHtml(data?.searchStatus || "Search")}</strong><span>${options.length} option${options.length === 1 ? "" : "s"} · revision ${escapeHtml(data?.planRevision ?? "—")}</span></div>${
          options.length
            ? options
                .map(
                  (option, index) => `
          <article class="autoplan-row">
            <div class="option-title"><strong>Option ${index + 1}</strong><span class="score">Score ${escapeHtml(option.score ?? "—")} · ${escapeHtml(option.credits ?? "—")} credits · ${escapeHtml(option.campusDays ?? "—")} campus days</span></div>
            <div class="option-courses">${[...(option.selected || []), ...(option.fillers || []).map((item) => ({ ...item, isFiller: true }))].map((item) => `<div><strong>${escapeHtml(item.courseCode)}${item.isFiller ? " · suggested" : ""}</strong><span>${escapeHtml((item.sectionLabels || []).join(" + "))}</span></div>`).join("")}</div>
            ${(option.unselectedCourses || []).length ? `<p class="small-note">Not selected: ${escapeHtml(option.unselectedCourses.map((item) => item.courseCode || item).join(", "))}</p>` : ""}
            ${(option.conflicts?.blocking || []).length ? `<p class="notice">${escapeHtml(option.conflicts.blocking.length)} blocking conflicts</p>` : ""}
            <button class="button small primary" data-option-index="${index}" type="button">Apply option</button>
          </article>`,
                )
                .join("")
            : '<div class="empty">No options found.</div>'
        }${data?.diagnostics?.length ? renderDiagnostics(data.diagnostics) : ""}`;
      $$("[data-option-index]").forEach((button) => {
        button.addEventListener("click", () =>
          applyAutoPlan(
            options[Number(button.dataset.optionIndex)],
            data.planRevision,
          ),
        );
      });
    } catch (error) {
      $("#autoplan-results").innerHTML =
        `<div class="empty error-text">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  function parseAutoPlanGroups(value) {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        const match =
          /^([\w-]+)\s*:\s*([^|]+?)(?:\s*\|\s*min\s*=\s*(\d+))?(?:\s*\|\s*max\s*=\s*(\d+))?\s*$/i.exec(
            line,
          );
        if (!match)
          throw new Error(
            `Invalid group on line ${index + 1}. Use id: CODE, CODE | min=1 | max=1.`,
          );
        const courseCodes = match[2]
          .split(/[\s,]+/)
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean);
        return {
          id: match[1],
          courseCodes,
          minCount: Number(match[3] ?? 0),
          maxCount: Number(match[4] ?? courseCodes.length),
        };
      });
  }

  function checkedValues(selector) {
    return $$(selector.concat(" input:checked")).map((input) => input.value);
  }
  function numberField(selector) {
    const value = $(selector).value;
    return value === "" ? undefined : Number(value);
  }
  function timeField(selector) {
    return $(selector).value || undefined;
  }

  async function applyAutoPlan(option, revision) {
    const plan = state.selectedPlan;
    if (!plan) return;
    try {
      const response = await apiRequest(
        `/plans/${encodeURIComponent(plan.id)}/auto-plans/apply`,
        {
          method: "POST",
          headers: {
            "If-Match": `"${revision}"`,
            "Idempotency-Key": idempotencyKey(),
          },
          body: { optionToken: option.optionToken },
        },
      );
      state.selectedPlan = response.data?.data || null;
      toast("Option applied to the plan.");
      await loadSelectedPlan();
      switchTab("plan");
    } catch (error) {
      toast(error.message, true);
    }
  }

  function zoneOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .reduce((result, part) => {
        if (part.type !== "literal") result[part.type] = Number(part.value);
        return result;
      }, {});
    return (
      (Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      ) -
        date.getTime()) /
      60000
    );
  }

  function zonedTimeToIso(dateText, timeText, timeZone) {
    const [year, month, day] = dateText.split("-").map(Number);
    const [hour, minute] = timeText.split(":").map(Number);
    const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
    let timestamp = desired;
    for (let i = 0; i < 3; i++) {
      const offset = zoneOffsetMinutes(new Date(timestamp), timeZone);
      timestamp = desired - offset * 60000;
    }
    const result = new Date(timestamp);
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(result)
      .reduce((record, part) => {
        if (part.type !== "literal") record[part.type] = part.value;
        return record;
      }, {});
    if (
      `${local.year}-${local.month}-${local.day}` !== dateText ||
      `${local.hour}:${local.minute}` !== timeText
    )
      throw new Error(
        "That local time does not exist in the selected time zone.",
      );
    return result.toISOString();
  }

  function eventModeChanged() {
    const mode = $("#event-mode").value;
    $$("[data-event-mode]").forEach((group) => {
      group.hidden = !group.dataset.eventMode.split(" ").includes(mode);
    });
  }

  function localDateTimeParts(value, timeZone) {
    const fields = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date(value))
        .map((part) => [part.type, part.value]),
    );
    return {
      date: fields.year + "-" + fields.month + "-" + fields.day,
      time: fields.hour + ":" + fields.minute,
    };
  }

  function beginEventEdit(event) {
    if (event.readonly) return toast("Imported events are read-only.", true);
    state.editingEvent = { id: event.id, revision: event.revision };
    $("#event-title").value = event.title || "";
    $("#event-type").value = event.eventType || "other";
    $("#event-location").value = event.location || "";
    $("#event-description").value = event.description || "";
    $("#event-color").value = /^#[0-9a-f]{6}$/i.test(event.color || "")
      ? event.color
      : "#176b62";
    $("#event-timezone").value = event.timezone || "Asia/Hong_Kong";
    $("#event-blocks-time").checked = event.blocksTime !== false;
    $("#event-supersedes").value = event.supersedesCalendarKey || "";
    $("#event-source-name").value = event.sourceName || "";
    $("#event-external-id").value = event.externalId || "";
    if (event.allDay) {
      $("#event-mode").value = "all-day";
      $("#event-date").value = event.startDate || "";
      $("#event-end-date").value = event.endDate || "";
    } else {
      const start = localDateTimeParts(event.startsAt, event.timezone);
      const end = localDateTimeParts(event.endsAt, event.timezone);
      $("#event-mode").value = event.recurrence ? "weekly" : "timed";
      $("#event-date").value = start.date;
      $("#event-start").value = start.time;
      $("#event-end").value = end.time;
      $("#event-until").value = event.recurrence?.until || "";
      $$("[name=event-weekday]").forEach((input) => {
        input.checked =
          event.recurrence?.weekdays?.includes(input.value) || false;
      });
    }
    $("#event-create").textContent = "Save event";
    $("#event-cancel-edit").hidden = false;
    eventModeChanged();
    switchTab("schedule");
  }

  function cancelEventEdit() {
    state.editingEvent = null;
    $("#event-create").textContent = "Create event";
    $("#event-cancel-edit").hidden = true;
    $("#event-source-name").value = "";
    $("#event-external-id").value = "";
  }

  async function createEvent() {
    try {
      const mode = $("#event-mode").value;
      const event = {
        title: $("#event-title").value.trim(),
        eventType: $("#event-type").value,
        blocksTime: $("#event-blocks-time").checked,
        location: $("#event-location").value.trim(),
        description: $("#event-description").value.trim(),
        color: $("#event-color").value,
        ...($("#event-supersedes").value.trim()
          ? { supersedesCalendarKey: $("#event-supersedes").value.trim() }
          : {}),
      };
      if (!state.editingEvent) {
        if ($("#event-source-name").value.trim())
          event.sourceName = $("#event-source-name").value.trim();
        if ($("#event-external-id").value.trim())
          event.externalId = $("#event-external-id").value.trim();
      }
      if (mode === "all-day") {
        event.allDay = true;
        event.startDate = $("#event-date").value;
        event.endDate = $("#event-end-date").value;
        if (
          !event.startDate ||
          !event.endDate ||
          event.startDate >= event.endDate
        )
          throw new Error("Choose valid all-day start and end dates.");
      } else {
        const date = $("#event-date").value;
        const zone = $("#event-timezone").value.trim() || "Asia/Hong_Kong";
        event.timezone = zone;
        event.startsAt = zonedTimeToIso(date, $("#event-start").value, zone);
        event.endsAt = zonedTimeToIso(date, $("#event-end").value, zone);
        if (event.endsAt <= event.startsAt)
          throw new Error("End time must be after start time.");
        if (mode === "weekly") {
          const weekdays = $$("[name=event-weekday]:checked").map(
            (input) => input.value,
          );
          if (!weekdays.length) throw new Error("Choose at least one weekday.");
          event.recurrence = {
            frequency: "weekly",
            interval: 1,
            weekdays,
            until: $("#event-until").value,
          };
        }
      }
      const edit = state.editingEvent;
      await apiRequest(
        edit ? "/events/" + encodeURIComponent(edit.id) : "/events",
        {
          method: edit ? "PATCH" : "POST",
          headers: edit
            ? { "If-Match": '"' + edit.revision + '"' }
            : { "Idempotency-Key": idempotencyKey() },
          body: event,
        },
      );
      toast(edit ? "Event updated." : "Event created.");
      cancelEventEdit();
      await listEvents();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function listEvents(cursor = null) {
    try {
      const query = new URLSearchParams({ limit: "50" });
      for (const [name, selector] of [
        ["eventType", "#event-filter-type"],
        ["source", "#event-filter-source"],
        ["readonly", "#event-filter-readonly"],
        ["from", "#event-filter-from"],
        ["to", "#event-filter-to"],
      ]) {
        const value = $(selector)?.value;
        if (value) query.set(name, value);
      }
      if (cursor) query.set("cursor", cursor);
      const response = await apiRequest("/events?" + query);
      const rows = response.data?.items || [];
      state.currentEvents = cursor ? [...state.currentEvents, ...rows] : rows;
      state.eventCursor = response.data?.page?.nextCursor || null;
      const displayRows = state.currentEvents;
      $("#event-results").innerHTML = displayRows.length
        ? displayRows
            .map(
              (event) => `
          <div class="event-row">
            <div><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.startsAt || event.startDate || "")}</small></div>
            <span class="badge">${escapeHtml(event.eventType || "other")}</span>
          </div>`,
            )
            .join("")
        : '<div class="empty">No events.</div>';
      $("#event-results")
        .querySelectorAll(".event-row")
        .forEach((row, index) => {
          const event = displayRows[index];
          if (!event || event.readonly) return;
          const actions = document.createElement("div");
          actions.className = "event-actions";
          actions.innerHTML =
            '<button class="link-button" data-event-edit="' +
            index +
            '" type="button">Edit</button><button class="link-button danger-link" data-event-delete="' +
            index +
            '" type="button">Delete</button>';
          row.append(actions);
        });
      $$("[data-event-edit]").forEach((button) => {
        button.addEventListener("click", () =>
          beginEventEdit(displayRows[Number(button.dataset.eventEdit)]),
        );
      });
      $$("[data-event-delete]").forEach((button) => {
        button.addEventListener("click", () =>
          deleteEvent(displayRows[Number(button.dataset.eventDelete)]),
        );
      });
      renderPageNav("#event-pagination", response.data?.page, (nextCursor) =>
        listEvents(nextCursor),
      );
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function importIcs() {
    const body = $("#ics-body").value;
    if (!body.trim()) return toast("Paste or choose an ICS file first.", true);
    const query = new URLSearchParams();
    if ($("#ics-from").value) query.set("from", $("#ics-from").value);
    if ($("#ics-to").value) query.set("to", $("#ics-to").value);
    if ($("#ics-blocks").value)
      query.set("defaultBlocksTime", $("#ics-blocks").value);
    try {
      const response = await apiRequest(
        "/events/import/ics" + (query.size ? "?" + query : ""),
        {
          method: "POST",
          headers: {
            "Content-Type": "text/calendar",
            "Idempotency-Key": idempotencyKey(),
          },
          body,
        },
      );
      const result = response.data?.data || response.data;
      toast(
        "Calendar imported: " +
          (result.created ?? 0) +
          " created, " +
          (result.updated ?? 0) +
          " updated, " +
          (result.rejected ?? 0) +
          " rejected.",
      );
      await refreshIcsImports();
      await listEvents();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function refreshIcsImports() {
    try {
      const response = await apiRequest("/events/imports");
      const rows = response.data?.data || [];
      $("#ics-imports").innerHTML = rows.length
        ? rows
            .map(
              (item, index) =>
                '<div class="item-row"><div><strong>' +
                escapeHtml(item.status) +
                "</strong><small>" +
                escapeHtml(item.importedAt) +
                " · " +
                escapeHtml(item.created) +
                " created · " +
                escapeHtml(item.updated) +
                " updated · " +
                escapeHtml(item.rejected) +
                " rejected</small></div>" +
                (item.status === "active"
                  ? '<button class="link-button danger-link" data-ics-delete="' +
                    index +
                    '" type="button">Remove</button>'
                  : "") +
                "</div>",
            )
            .join("")
        : '<div class="empty compact-empty">No calendar imports.</div>';
      $$("[data-ics-delete]").forEach((button) => {
        button.addEventListener("click", () =>
          deleteIcsImport(rows[Number(button.dataset.icsDelete)]),
        );
      });
    } catch (error) {
      $("#ics-imports").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
    }
  }

  async function deleteIcsImport(item) {
    try {
      await apiRequest("/events/imports/" + encodeURIComponent(item.importId), {
        method: "DELETE",
      });
      toast("Calendar import removed.");
      await refreshIcsImports();
      await listEvents();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function deleteEvent(event) {
    try {
      await apiRequest("/events/" + encodeURIComponent(event.id), {
        method: "DELETE",
        headers: { "If-Match": '"' + event.revision + '"' },
      });
      toast("Event deleted.");
      await listEvents();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function createWatch() {
    const targetType = $("#watch-target-type").value;
    const targetId = $("#watch-target-id").value.trim();
    const termCode = $("#watch-term").value;
    if (!targetId) return toast("Enter a course code or section ID.", true);
    try {
      const path =
        targetType === "course"
          ? "/courses/" +
            encodeURIComponent(targetId.toUpperCase()) +
            "/watch?termCode=" +
            encodeURIComponent(termCode)
          : "/sections/" + encodeURIComponent(targetId) + "/watch";
      await apiRequest(path, {
        method: "POST",
        body: { notificationPreference: $("#watch-preference").value },
      });
      toast("Watch added.");
      await refreshWatches();
    } catch (error) {
      toast(error.message, true);
    }
  }

  // A course watch covers many sections, so one number cannot describe it.
  // Render a range per component type, and call out full sections and any
  // waitlist queue. A section watch collapses to a single value per component.
  function renderQuotaSummary(summary) {
    if (!summary?.components?.length)
      return '<span class="quota-chip is-muted">no quota data</span>';
    const chips = summary.components.map((component) => {
      const range =
        component.remainingMin === null
          ? "unknown"
          : component.remainingMin === component.remainingMax
            ? String(component.remainingMin)
            : `${component.remainingMin}\u2013${component.remainingMax}`;
      const queue =
        component.waitlisted > 0
          ? ` <i>waitlist ${component.waitlisted}</i>`
          : "";
      return `<span class="quota-chip"><b>${escapeHtml(component.componentType)}</b> ${escapeHtml(range)}${queue}</span>`;
    });
    if (summary.full > 0)
      chips.push(
        `<span class="quota-chip is-full">${summary.full} of ${summary.sections} full</span>`,
      );
    if (summary.unknown > 0)
      chips.push(
        `<span class="quota-chip is-muted">${summary.unknown} unknown</span>`,
      );
    if (summary.missingSections > 0)
      chips.push(
        `<span class="quota-chip is-muted">${summary.missingSections} missing quota</span>`,
      );
    if (summary.staleSections > 0)
      chips.push(
        `<span class="quota-chip is-muted">${summary.staleSections} stale quota</span>`,
      );
    return chips.join("");
  }

  async function refreshWatches(cursor = null) {
    try {
      const query = new URLSearchParams({ limit: "50" });
      if ($("#watch-term").value) query.set("termCode", $("#watch-term").value);
      if ($("#watch-filter-target").value)
        query.set("targetType", $("#watch-filter-target").value);
      if (cursor) query.set("cursor", cursor);
      const response = await apiRequest("/watching?" + query);
      const rows = response.data?.items || [];
      state.watchCursor = response.data?.page?.nextCursor || null;
      state.watches = cursor ? [...(state.watches || []), ...rows] : rows;
      const displayRows = state.watches;
      $("#watch-list").innerHTML = displayRows.length
        ? displayRows
            .map(
              (watch, index) =>
                '<div class="item-row"><div><strong>' +
                escapeHtml(watch.targetId) +
                "</strong><small>" +
                escapeHtml(watch.targetType) +
                " · " +
                escapeHtml(watch.termCode) +
                " · " +
                escapeHtml(watch.notificationPreference) +
                " · " +
                escapeHtml(watch.freshness?.state || "unknown") +
                '</small><div class="quota-chips">' +
                renderQuotaSummary(watch.quotaSummary) +
                '</div></div><button class="link-button danger-link" data-watch-remove="' +
                index +
                '" type="button">Remove</button></div>',
            )
            .join("")
        : '<div class="empty">No watches for this term.</div>';
      $$("[data-watch-remove]").forEach((button) => {
        button.addEventListener("click", () =>
          removeWatch(displayRows[Number(button.dataset.watchRemove)]),
        );
      });
      renderPageNav("#watch-pagination", response.data?.page, (nextCursor) =>
        refreshWatches(nextCursor),
      );
    } catch (error) {
      $("#watch-list").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
    }
  }

  async function removeWatch(watch) {
    const path =
      watch.targetType === "course"
        ? "/courses/" +
          encodeURIComponent(watch.targetId) +
          "/watch?termCode=" +
          encodeURIComponent(watch.termCode)
        : "/sections/" + encodeURIComponent(watch.targetId) + "/watch";
    try {
      await apiRequest(path, { method: "DELETE" });
      toast("Watch removed.");
      await refreshWatches();
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function refreshNotifications(cursor = null) {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("cursor", cursor);
    if ($("#notifications-unread").checked) query.set("unreadOnly", "true");
    try {
      const response = await apiRequest("/watching/notifications?" + query);
      const rows = response.data?.items || [];
      state.notificationCursor = response.data?.page?.nextCursor || null;
      state.notifications = cursor
        ? [...(state.notifications || []), ...rows]
        : rows;
      const displayRows = state.notifications;
      $("#notification-list").innerHTML = displayRows.length
        ? displayRows
            .map(
              (item, index) =>
                '<div class="item-row"><div><strong>' +
                escapeHtml(item.changeType.replaceAll("_", " ")) +
                "</strong><small>" +
                escapeHtml(item.targetId) +
                " · " +
                escapeHtml(item.createdAt) +
                " · enrolled " +
                escapeHtml(item.afterState?.enrolled ?? "—") +
                " · waitlisted " +
                escapeHtml(item.afterState?.waitlisted ?? "—") +
                "</small></div>" +
                (item.readAt
                  ? '<span class="badge">Read</span>'
                  : '<button class="link-button" data-notification-read="' +
                    index +
                    '" type="button">Mark read</button>') +
                "</div>",
            )
            .join("")
        : '<div class="empty">No notifications.</div>';
      $$("[data-notification-read]").forEach((button) => {
        button.addEventListener("click", async () => {
          try {
            await apiRequest(
              "/watching/notifications/" +
                encodeURIComponent(
                  displayRows[Number(button.dataset.notificationRead)]
                    .notificationId,
                ),
              { method: "PATCH", body: { read: true } },
            );
            await refreshNotifications();
          } catch (error) {
            toast(error.message, true);
          }
        });
      });
      renderPageNav(
        "#notification-pagination",
        response.data?.page,
        (nextCursor) => refreshNotifications(nextCursor),
      );
    } catch (error) {
      $("#notification-list").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
    }
  }

  async function refreshSocial() {
    await Promise.all([refreshWatches(), refreshNotifications()]);
  }

  async function setDiscoverability(enabled) {
    const sectionId = $("#discovery-section").value.trim();
    if (!sectionId) return toast("Enter a section ID.", true);
    try {
      if (enabled) {
        const seconds = numberField("#discovery-expiry");
        const body = {
          displayName: $("#discovery-name").value.trim(),
          ...(seconds === undefined ? {} : { expiresInSeconds: seconds }),
        };
        const response = await apiRequest(
          "/sections/" + encodeURIComponent(sectionId) + "/discoverability",
          { method: "POST", body },
        );
        const data = response.data?.data || response.data;
        $("#discovery-results").innerHTML =
          '<div class="small-note">Opted in as ' +
          escapeHtml(data.displayName) +
          " until " +
          escapeHtml(data.expiresAt) +
          ".</div>";
      } else {
        await apiRequest(
          "/sections/" + encodeURIComponent(sectionId) + "/discoverability",
          { method: "DELETE" },
        );
        $("#discovery-results").innerHTML =
          '<div class="small-note">Discovery opt-in removed.</div>';
      }
      toast(enabled ? "Discovery enabled." : "Discovery disabled.");
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function findClassmates(cursor = null) {
    const sectionId = $("#discovery-section").value.trim();
    if (!sectionId) return toast("Enter a section ID.", true);
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await apiRequest(
        "/sections/" + encodeURIComponent(sectionId) + "/classmates?" + query,
      );
      const rows = response.data?.items || [];
      state.discoveryCursor = response.data?.page?.nextCursor || null;
      state.classmates = cursor ? [...(state.classmates || []), ...rows] : rows;
      const displayRows = state.classmates;
      $("#discovery-results").innerHTML = displayRows.length
        ? displayRows
            .map(
              (row) =>
                '<div class="item-row"><div><strong>' +
                escapeHtml(row.displayName) +
                "</strong><small>" +
                escapeHtml(row.sectionLabel) +
                " · opted in " +
                escapeHtml(row.optedInAt) +
                "</small></div></div>",
            )
            .join("")
        : '<div class="empty">No opted-in matches found.</div>';
      renderPageNav(
        "#discovery-pagination",
        response.data?.page,
        (nextCursor) => findClassmates(nextCursor),
      );
    } catch (error) {
      $("#discovery-results").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
      toast(error.message, true);
    }
  }

  async function loadCommonCore() {
    const year = numberField("#common-core-year");
    const termCode = $("#common-core-term").value;
    if (!year || !termCode)
      return toast("Choose an admission year and term.", true);
    try {
      const response = await apiRequest(
        "/common-core/presets?admissionYear=" +
          encodeURIComponent(year) +
          "&termCode=" +
          encodeURIComponent(termCode),
      );
      const data = response.data?.data || response.data;
      $("#common-core-results").innerHTML =
        '<p class="small-note">' +
        escapeHtml(data.schemeId) +
        " · catalog " +
        escapeHtml(data.catalogVersion) +
        (data.isStale ? " · stale" : "") +
        "</p>" +
        (data.categories || [])
          .map(
            (category) =>
              '<div class="item-row"><div><strong>' +
              escapeHtml(category.label) +
              "</strong><small>" +
              escapeHtml(category.categoryId) +
              " · " +
              escapeHtml(category.offeredCourseCount) +
              " offered courses</small></div></div>",
          )
          .join("");
    } catch (error) {
      $("#common-core-results").innerHTML =
        '<div class="empty error-text">' + escapeHtml(error.message) + "</div>";
      toast(error.message, true);
    }
  }

  async function checkQuota(trends = false, cursor = null) {
    const sectionId = $("#quota-section").value.trim();
    if (!sectionId) {
      toast("Enter a section ID.", true);
      return;
    }
    try {
      const path = trends
        ? "/quota/trends?window=" +
          encodeURIComponent($("#quota-window").value) +
          "&limit=" +
          encodeURIComponent($("#quota-limit").value || "30") +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : "")
        : "/quota";
      const response = await apiRequest(
        `/sections/${encodeURIComponent(sectionId)}${path}`,
      );
      const data = response.data?.data || response.data;
      state.quotaCursor = trends
        ? response.data?.page?.nextCursor || null
        : null;
      $("#quota-result").innerHTML = trends
        ? `<pre class="inline-json">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`
        : renderQuota(data);
      renderPageNav(
        "#quota-pagination",
        trends ? response.data?.page : null,
        (nextCursor) => checkQuota(true, nextCursor),
      );
    } catch (error) {
      $("#quota-result").innerHTML =
        `<div class="empty error-text">${escapeHtml(error.message)}</div>`;
      toast(error.message, true);
    }
  }

  function renderQuota(quota) {
    const remaining = quota?.remaining;
    const capacity = quota?.capacity;
    const enrolled = quota?.enrolled;
    const freshness = quota?.freshness?.state || "unknown";
    return `
      <div class="quota-summary">
        <div><span>Remaining</span><strong>${remaining ?? "—"}</strong></div>
        <div><span>Enrolled</span><strong>${enrolled ?? "—"} / ${capacity ?? "—"}</strong></div>
        <div><span>Waitlisted</span><strong>${quota?.waitlisted ?? "—"}</strong></div>
        <div><span>Updated</span><strong>${escapeHtml(quota?.observedAt || "—")}</strong></div>
      </div><p class="small-note">Quota data: ${escapeHtml(freshness)}.</p>`;
  }

  function resolveOpenApiSchema(schema) {
    if (!schema) return {};
    if (schema.$ref) {
      const name = schema.$ref.split("/").at(-1);
      return state.apiDocument?.components?.schemas?.[name] || {};
    }
    return schema;
  }

  function schemaExample(rawSchema, depth = 0) {
    if (depth > 5) return null;
    const schema = resolveOpenApiSchema(rawSchema);
    if (schema.enum) return schema.enum[0];
    if (schema.oneOf || schema.anyOf) {
      const variants = schema.oneOf || schema.anyOf;
      const nonNull = variants.find((variant) => variant.type !== "null");
      return schemaExample(nonNull || variants[0], depth + 1);
    }
    if (schema.type === "object") {
      const result = {};
      for (const [key, value] of Object.entries(schema.properties || {}))
        result[key] = schemaExample(value, depth + 1);
      return result;
    }
    if (schema.type === "array")
      return [schemaExample(schema.items || {}, depth + 1)];
    if (schema.type === "boolean") return false;
    if (schema.type === "integer" || schema.type === "number")
      return schema.minimum ?? 1;
    if (schema.format === "date") return "2026-09-01";
    if (schema.format === "date-time") return "2026-09-01T09:00:00+08:00";
    return schema.example ?? schema.default ?? "";
  }

  function schemaControl(name, schema, location, required, index) {
    const resolved = resolveOpenApiSchema(schema);
    const title = escapeHtml(resolved.description || name);
    const requiredMark = required ? " *" : "";
    if (resolved.enum) {
      return (
        '<label class="field"><span>' +
        title +
        requiredMark +
        '</span><select data-api-param="' +
        location +
        ":" +
        index +
        '">' +
        resolved.enum
          .map(
            (value) =>
              '<option value="' +
              escapeHtml(value) +
              '">' +
              escapeHtml(value) +
              "</option>",
          )
          .join("") +
        "</select></label>"
      );
    }
    if (resolved.type === "array") {
      return (
        '<label class="field"><span>' +
        title +
        requiredMark +
        '</span><input data-api-param="' +
        location +
        ":" +
        index +
        '" data-api-array="true" type="text" placeholder="comma-separated values" ' +
        (required ? "required" : "") +
        " /></label>"
      );
    }
    const type =
      resolved.format === "date"
        ? "date"
        : resolved.format === "date-time"
          ? "datetime-local"
          : resolved.type === "integer" || resolved.type === "number"
            ? "number"
            : resolved.type === "boolean"
              ? "checkbox"
              : "text";
    if (type === "checkbox") {
      return (
        '<label class="checkbox-line"><input data-api-param="' +
        location +
        ":" +
        index +
        '" data-api-optional="' +
        !required +
        '" type="checkbox" /> ' +
        title +
        requiredMark +
        "</label>"
      );
    }
    return (
      '<label class="field"><span>' +
      title +
      requiredMark +
      '</span><input data-api-param="' +
      location +
      ":" +
      index +
      '" type="' +
      type +
      '" ' +
      (resolved.type === "integer" || resolved.type === "number"
        ? 'step="any" '
        : "") +
      (required ? "required " : "") +
      'placeholder="' +
      escapeHtml(resolved.example || "") +
      '" /></label>'
    );
  }

  async function loadApiOperations() {
    try {
      const response = await fetch(
        state.api.replace(/\/$/, "") + "/documentation/json",
        { headers: { Accept: "application/json" } },
      );
      if (!response.ok)
        throw new Error(
          "Could not load OpenAPI routes (" + response.status + ").",
        );
      state.apiDocument = await response.json();
      state.apiOperations = [];
      for (const [path, pathItem] of Object.entries(
        state.apiDocument.paths || {},
      )) {
        for (const method of ["get", "post", "patch", "put", "delete"]) {
          const operation = pathItem[method];
          if (!operation) continue;
          state.apiOperations.push({ path, pathItem, method, operation });
        }
      }
      state.apiOperations.sort(
        (a, b) =>
          a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
      );
      $("#api-operation").innerHTML = state.apiOperations
        .map(
          (item, index) =>
            '<option value="' +
            index +
            '">' +
            item.method.toUpperCase() +
            " " +
            escapeHtml(item.path) +
            " · " +
            escapeHtml(
              item.operation.summary || item.operation.tags?.[0] || "",
            ) +
            "</option>",
        )
        .join("");
      renderApiOperation();
    } catch (error) {
      $("#api-operation").innerHTML =
        '<option value="">API routes unavailable</option>';
      $("#api-operation-summary").textContent = error.message;
      toast(error.message, true);
    }
  }

  function currentApiOperation() {
    const index = Number($("#api-operation").value);
    return state.apiOperations[index];
  }

  function renderApiOperation() {
    const selected = currentApiOperation();
    if (!selected) return;
    const { operation, pathItem, path, method } = selected;
    $("#api-operation-summary").textContent =
      operation.summary ||
      operation.description ||
      method.toUpperCase() + " " + path;
    const parameters = [
      ...(pathItem.parameters || []),
      ...(operation.parameters || []),
    ];
    for (const location of ["path", "query"]) {
      const rows = parameters.filter((parameter) => parameter.in === location);
      const target =
        location === "path"
          ? $("#api-path-parameters")
          : $("#api-query-parameters");
      target.className = "api-operation-params";
      target.innerHTML = rows
        .map((parameter, index) =>
          schemaControl(
            parameter.name,
            parameter.schema,
            location,
            parameter.required,
            index,
          ),
        )
        .join("");
      rows.forEach((parameter, index) => {
        const input = target.querySelector(
          '[data-api-param="' + location + ":" + index + '"]',
        );
        if (parameter.example !== undefined) input.value = parameter.example;
        else if (parameter.schema?.example !== undefined)
          input.value = parameter.schema.example;
      });
    }
    const requestBody =
      operation.requestBody ||
      (path === "/events/import/ics"
        ? { required: true, content: { "text/calendar": {} } }
        : null);
    const content = requestBody?.content || {};
    const types = Object.keys(content);
    $("#api-content-type").innerHTML = types.length
      ? types
          .map(
            (type) =>
              '<option value="' +
              escapeHtml(type) +
              '">' +
              escapeHtml(type) +
              "</option>",
          )
          .join("")
      : '<option value="application/json">application/json</option>';
    $("#api-content-type").disabled = types.length < 2;
    $("#api-if-match").value = "";
    $("#api-idempotency").value = "";
    const bodySchema = types.length ? content[types[0]].schema : null;
    $("#api-request-body").value = bodySchema
      ? JSON.stringify(schemaExample(bodySchema), null, 2)
      : path === "/events/import/ics"
        ? "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//USThing//Calendar//EN\nEND:VCALENDAR"
        : "";
    $("#api-request-body").hidden = !requestBody;
    $("#api-content-type").closest(".form-grid").hidden =
      !requestBody && !["patch", "delete"].includes(method);
  }

  async function sendApiOperation() {
    const selected = currentApiOperation();
    if (!selected) return toast("Choose an API operation.", true);
    const { operation, pathItem, method } = selected;
    const parameters = [
      ...(pathItem.parameters || []),
      ...(operation.parameters || []),
    ];
    let path = selected.path;
    const query = new URLSearchParams();
    for (const location of ["path", "query"]) {
      parameters
        .filter((parameter) => parameter.in === location)
        .forEach((parameter, index) => {
          const input = $('[data-api-param="' + location + ":" + index + '"]');
          if (
            input.type === "checkbox" &&
            !input.checked &&
            !parameter.required
          )
            return;
          const value =
            input.type === "checkbox" ? String(input.checked) : input.value;
          if (parameter.required && !value)
            throw new Error(parameter.name + " is required.");
          if (!value) return;
          if (location === "path")
            path = path.replace(
              "{" + parameter.name + "}",
              encodeURIComponent(value),
            );
          else if (input.dataset.apiArray === "true") {
            for (const item of value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean))
              query.append(parameter.name, item);
          } else query.set(parameter.name, value);
        });
    }
    if (/[{}]/.test(path))
      return toast("Fill all required path parameters.", true);
    if (query.size) path += (path.includes("?") ? "&" : "?") + query;
    const headers = {};
    const ifMatch = $("#api-if-match").value.trim();
    const idempotency = $("#api-idempotency").value.trim();
    if (ifMatch) headers["If-Match"] = ifMatch;
    if (idempotency) headers["Idempotency-Key"] = idempotency;
    let body;
    const requestBody =
      operation.requestBody ||
      (selected.path === "/events/import/ics" ? { required: true } : null);
    if (requestBody) {
      const raw = $("#api-request-body").value;
      const contentType = $("#api-content-type").value;
      headers["Content-Type"] = contentType;
      if (requestBody.required && !raw.trim())
        return toast("A request body is required.", true);
      if (contentType === "application/json" && raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          return toast("Request body must be valid JSON.", true);
        }
      } else if (raw) {
        body = raw;
      }
    }
    try {
      await apiRequest(path, {
        method: method.toUpperCase(),
        ...(body === undefined ? {} : { body }),
        headers,
        public: !operation.security?.length,
      });
      toast("Request completed.");
    } catch (error) {
      toast(error.message, true);
    }
  }

  // Tabs other than Schedule load their data on first visit. Doing it eagerly
  // for every tab would fire a dozen requests on page load for views the user
  // may never open.
  const loadedTabs = new Set();

  function switchTab(name) {
    $$(".tab").forEach((button) => {
      const active = button.dataset.tab === name;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $$(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.panel === name);
    });
    location.hash = name;
    primeTab(name);
  }

  function primeTab(name) {
    if (loadedTabs.has(name)) return;
    loadedTabs.add(name);
    // Schedule is primed during boot, so only the others need work here.
    const jobs = {
      plan: () => refreshPlans(),
      watching: () => refreshSocial(),
    };
    jobs[name]?.()?.catch?.(() => {});
  }

  function shortcut(name) {
    if (name === "math") {
      switchTab("courses");
      $("#course-search").value = "MATH1013";
      $("#course-search").focus();
      searchCourses();
    } else if (name === "current-term") {
      switchTab("schedule");
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + 90);
      $("#calendar-from").value = localDate(now);
      $("#calendar-to").value = localDate(end);
    } else if (name === "autoplan") {
      switchTab("plan");
      $("#autoplan-courses").value = "MATH1013\nCOMP2012";
      $("#autoplan-courses").focus();
    } else if (name === "event-example") {
      switchTab("schedule");
      $("#event-title").value = "Weekly study group";
      $("#event-mode").value = "weekly";
      $("#event-start").value = "10:00";
      $("#event-end").value = "11:00";
      eventModeChanged();
      $("#event-title").focus();
    }
  }

  let pendingGo = false;
  let pendingGoTimer;
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const editing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if (editing) return;
    if (event.key === "/") {
      event.preventDefault();
      switchTab("courses");
      $("#course-search").focus();
      return;
    }
    if (event.key === "Escape") {
      $("#toast-region").replaceChildren();
      return;
    }
    const key = event.key.toLowerCase();
    if (pendingGo) {
      pendingGo = false;
      clearTimeout(pendingGoTimer);
      const tabs = {
        c: "courses",
        k: "schedule",
        p: "plan",
        e: "schedule",
        s: "watching",
        t: "developer",
      };
      if (tabs[key]) {
        event.preventDefault();
        switchTab(tabs[key]);
      }
      return;
    }
    if (key === "g") {
      pendingGo = true;
      clearTimeout(pendingGoTimer);
      pendingGoTimer = setTimeout(() => {
        pendingGo = false;
      }, 900);
    }
  });

  $("#api-base").value = state.api;
  updateApiDocsLink();
  $("#identity").value = state.identity;
  $("#api-base").addEventListener("change", () => {
    state.api = $("#api-base").value.trim();
    localStorage.setItem("usthing-api-base", state.api);
    updateApiDocsLink();
    loadTerms();
    loadApiOperations();
    checkHealth();
  });
  $("#identity").addEventListener("change", () => {
    state.identity = $("#identity").value;
    localStorage.setItem("usthing-api-identity", state.identity);
    $("#custom-token-wrap").hidden = state.identity !== "custom";
  });
  bindBusy("#health-button", checkHealth, "Checking...");
  $$(".tab").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  $$("[data-shortcut]").forEach((button) => {
    button.addEventListener("click", () => shortcut(button.dataset.shortcut));
  });
  bindBusy("#course-search-button", searchCourses, "Searching...");
  $("#course-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#course-search-button").click();
  });
  $("#copy-offering").addEventListener("click", () => {
    if (state.currentOffering?.offeringId)
      copyText(state.currentOffering.offeringId, "Offering ID copied.");
  });
  bindBusy("#calendar-load", () => loadCalendar(false), "Loading...");
  bindBusy("#conflict-load", () => loadCalendar(true), "Checking...");
  bindBusy("#calendar-banner", loadCalendarBanner, "Loading...");
  bindBusy("#calendar-export", exportCalendar, "Exporting...");
  $("#calendar-term").addEventListener("change", () => refreshPlans());
  bindBusy("#create-plan", createPlan, "Creating...");
  bindBusy("#refresh-plans", refreshPlans, "Refreshing...");
  $("#plan-select").addEventListener("change", () => loadSelectedPlan());
  $("#plan-term").addEventListener("change", () => refreshPlans());
  $("#plan-filter-status").addEventListener("change", () => refreshPlans());
  bindBusy("#activate-plan", () => changePlanStatus("active"), "Activating...");
  bindBusy("#archive-plan", () => changePlanStatus("archived"), "Archiving...");
  bindBusy("#save-plan", savePlanDetails, "Saving...");
  bindBusy("#create-share", createShare, "Creating...");
  bindBusy("#refresh-shares", refreshShares, "Refreshing...");
  bindBusy("#read-shared-plan", readSharedPlan, "Loading...");
  bindBusy("#autoplan-run", runAutoPlan, "Generating...");
  bindBusy("#recommend-run", runRecommendations, "Finding...");
  $("#event-mode").addEventListener("change", eventModeChanged);
  bindBusy("#event-create", createEvent, "Saving...");
  $("#event-cancel-edit").addEventListener("click", cancelEventEdit);
  bindBusy("#event-list", listEvents, "Refreshing...");
  [
    "#event-filter-type",
    "#event-filter-source",
    "#event-filter-readonly",
    "#event-filter-from",
    "#event-filter-to",
  ].forEach((selector) => {
    $(selector).addEventListener("change", () => {
      listEvents();
    });
  });
  bindBusy("#ics-import", importIcs, "Importing...");
  bindBusy("#refresh-ics-imports", refreshIcsImports, "Refreshing...");
  $("#ics-file").addEventListener("change", async () => {
    const file = $("#ics-file").files?.[0];
    if (file) $("#ics-body").value = await file.text();
  });
  bindBusy("#watch-create", createWatch, "Adding...");
  bindBusy("#refresh-social", refreshSocial, "Refreshing...");
  $("#watch-filter-target").addEventListener("change", () => refreshWatches());
  bindBusy("#refresh-notifications", refreshNotifications, "Refreshing...");
  $("#notifications-unread").addEventListener("change", () =>
    refreshNotifications(),
  );
  $("#discovery-enable").addEventListener("click", () =>
    setDiscoverability(true),
  );
  $("#discovery-disable").addEventListener("click", () =>
    setDiscoverability(false),
  );
  bindBusy("#discovery-search", findClassmates, "Searching...");
  bindBusy("#common-core-load", loadCommonCore, "Loading...");
  bindBusy("#quota-check", () => checkQuota(false), "Checking...");
  bindBusy("#quota-trends", () => checkQuota(true), "Loading...");
  bindBusy("#api-operations-refresh", loadApiOperations, "Refreshing...");
  $("#api-operation").addEventListener("change", renderApiOperation);
  bindBusy("#api-operation-send", sendApiOperation, "Sending...");
  $("#raw-clear").addEventListener("click", (event) => {
    event.preventDefault();
    $("#raw-status").textContent = "No request yet";
    $("#raw-output").textContent = "Responses appear here after an operation.";
  });
  $("#custom-token-wrap").hidden = state.identity !== "custom";
  setDateDefaults();
  eventModeChanged();
  const TAB_NAMES = ["schedule", "plan", "courses", "watching", "developer"];
  const initialTab = location.hash.slice(1);
  if (TAB_NAMES.includes(initialTab)) switchTab(initialTab);
  // Schedule is the landing tab, so its data is primed rather than waiting for
  // a click. Terms must resolve first because both calls filter on the term.
  loadTerms()
    .then(() => {
      listEvents();
      return loadCalendar();
    })
    .catch(() => {});
  loadApiOperations();
  setTimeout(checkHealth, 250);
})();
