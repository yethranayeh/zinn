import MarkdownCommands from "../components/MarkdownCommands.astro";
import MarkdownH1 from "../components/MarkdownH1.astro";
import MarkdownH2 from "../components/MarkdownH2.astro";
import MarkdownH3 from "../components/MarkdownH3.astro";
import MarkdownList from "../components/MarkdownList.astro";
import Table from "../components/ui/table/Table.astro";
import TableCell from "../components/ui/table/TableCell.astro";
import TableHead from "../components/ui/table/TableHead.astro";
import TableRow from "../components/ui/table/TableRow.astro";

// The components MDX docs pages render in place of these elements.
export const components = {
  h1: MarkdownH1,
  h2: MarkdownH2,
  h3: MarkdownH3,
  ul: MarkdownList,
  pre: MarkdownCommands,
  table: Table,
  th: TableHead,
  td: TableCell,
  tr: TableRow,
};
