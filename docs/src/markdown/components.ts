import MarkdownCommands from "../components/MarkdownCommands.astro";
import MarkdownH1 from "../components/MarkdownH1.astro";
import MarkdownH2 from "../components/MarkdownH2.astro";
import MarkdownH3 from "../components/MarkdownH3.astro";
import MarkdownList from "../components/MarkdownList.astro";

// The components MDX docs pages render in place of these elements.
export const components = {
  h1: MarkdownH1,
  h2: MarkdownH2,
  h3: MarkdownH3,
  ul: MarkdownList,
  pre: MarkdownCommands,
};
