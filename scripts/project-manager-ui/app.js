const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const projectList = document.querySelector("#project-list");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refresh-projects");
const createForm = document.querySelector("#create-form");
const createFormView = document.querySelector("#create-form-view");
const successView = document.querySelector("#creation-success");
const creationSummary = document.querySelector("#creation-summary");
const openCreatedButton = document.querySelector("#open-created");
let createdProject = null;

function setNotice(message, kind = "info") {
  notice.hidden = message === "";
  notice.textContent = message;
  notice.dataset.kind = kind;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-SquillPad-Manager-Token": token,
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "The request failed.");
  return body;
}

function renderProjects(projects) {
  projectList.replaceChildren();
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      "<h3>No projects yet</h3><p>Create your first project using the form.</p>";
    projectList.append(empty);
    return;
  }
  const template = document.querySelector("#project-template");
  for (const project of projects) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.querySelector(".project-name").textContent = project.name;
    card.querySelector(".project-path").textContent = project.projectDirectory;
    card.querySelector(".project-port").textContent =
      project.defaultPort === 0
        ? "Automatic port"
        : `Port ${project.defaultPort}`;
    const badge = card.querySelector(".status-badge");
    badge.textContent = project.available ? "Ready" : "Unavailable";
    badge.dataset.status = project.available ? "ready" : "problem";
    card.querySelector(".legacy-note").hidden = !project.legacyMetadata;
    const problem = card.querySelector(".project-problem");
    problem.hidden = project.available;
    problem.textContent = project.problem ?? "";
    const openButton = card.querySelector(".open-project");
    openButton.disabled = !project.available;
    openButton.title = project.available
      ? `Open ${project.name}`
      : (project.problem ?? "Project unavailable");
    openButton.addEventListener("click", () =>
      openProject(project, openButton),
    );
    projectList.append(card);
  }
}

async function loadProjects() {
  projectList.setAttribute("aria-busy", "true");
  refreshButton.disabled = true;
  try {
    const { projects } = await request("/api/projects");
    renderProjects(projects);
    setNotice("");
  } catch (error) {
    projectList.replaceChildren();
    setNotice(error.message, "error");
  } finally {
    projectList.setAttribute("aria-busy", "false");
    refreshButton.disabled = false;
  }
}

async function openProject(project, button) {
  button.disabled = true;
  setNotice(`Preparing ${project.name}…`);
  try {
    const result = await request("/api/open", {
      method: "POST",
      body: JSON.stringify({ id: project.id }),
    });
    const portMessage = result.overridden
      ? ` Port ${project.defaultPort} was busy, so this run will use port ${result.port}.`
      : ` This run will use port ${result.port}.`;
    setNotice(
      `Opening ${project.name}.${portMessage} This chooser can now be closed.`,
    );
    document
      .querySelectorAll("button, input")
      .forEach((control) => (control.disabled = true));
  } catch (error) {
    setNotice(error.message, "error");
    button.disabled = false;
  }
}

createForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = document.querySelector("#create-project");
  const formData = new FormData(createForm);
  const details = {
    name: String(formData.get("name") ?? ""),
    directory: String(formData.get("directory") ?? ""),
    port: Number(formData.get("port")),
  };
  submitButton.disabled = true;
  submitButton.textContent = "Creating and building…";
  setNotice(
    "Creating the project and preparing the SquillPad runtime. This can take a moment.",
  );
  try {
    const result = await request("/api/create", {
      method: "POST",
      body: JSON.stringify(details),
    });
    createdProject = result.project;
    if (createdProject === null)
      throw new Error(
        "The project was created, but its launcher could not be found.",
      );
    creationSummary.textContent = `${createdProject.name} is ready at ${createdProject.projectDirectory}.`;
    createFormView.hidden = true;
    successView.hidden = false;
    openCreatedButton.focus();
    await loadProjects();
  } catch (error) {
    setNotice(error.message, "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Create project";
  }
});

openCreatedButton.addEventListener("click", () => {
  if (createdProject !== null)
    void openProject(createdProject, openCreatedButton);
});

document.querySelector("#back-to-projects").addEventListener("click", () => {
  createdProject = null;
  successView.hidden = true;
  createFormView.hidden = false;
  createForm.reset();
  document.querySelector("#project-port").value = "4173";
  document.querySelector("#project-name").focus();
});

refreshButton.addEventListener("click", loadProjects);

const themeButton = document.querySelector("#theme-toggle");
const storedTheme = localStorage.getItem("squillpad-manager-theme");
if (storedTheme === "light" || storedTheme === "dark")
  document.documentElement.dataset.theme = storedTheme;
themeButton.addEventListener("click", () => {
  const current =
    document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("squillpad-manager-theme", next);
});

if (token === "")
  setNotice("This project manager URL is missing its session token.", "error");
else void loadProjects();
