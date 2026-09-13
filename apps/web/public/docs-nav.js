(() => {
  const links = [...document.querySelectorAll('.section-nav a[href^="#"]')];
  const sections = links
    .map((link) => {
      const href = link.getAttribute("href");
      return href === null ? null : document.getElementById(href.slice(1));
    })
    .filter((section) => section !== null);

  if (links.length === 0 || sections.length === 0) return;

  const setCurrentSection = (sectionId) => {
    links.forEach((link) => {
      const isCurrent = link.getAttribute("href") === `#${sectionId}`;
      link.classList.toggle("is-current", isCurrent);
      if (isCurrent) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  };

  const updateCurrentSection = () => {
    const marker = window.scrollY + Math.min(window.innerHeight * 0.35, 240);
    let current = sections[0];
    sections.forEach((section) => {
      const top = section.getBoundingClientRect().top + window.scrollY;
      if (top <= marker) current = section;
    });
    setCurrentSection(current.id);
  };

  window.addEventListener("scroll", updateCurrentSection, { passive: true });
  window.addEventListener("resize", updateCurrentSection);
  window.addEventListener("hashchange", updateCurrentSection);
  updateCurrentSection();
})();
