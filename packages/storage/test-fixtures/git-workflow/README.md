# Git workflow fixture

This directory is a small canonical project fixture for the Phase 7 Git scenario:

1. initialize Git and commit the files;
2. edit `sections/123e4567-e89b-42d3-a456-426614174000/pages/223e4567-e89b-42d3-a456-426614174001/markdown/323e4567-e89b-42d3-a456-426614174002.md`;
3. inspect the one-file Markdown diff and commit it;
4. edit that Markdown file outside the application;
5. reopen the project and verify the external source is loaded unchanged.

The fixture deliberately contains no `.git` directory. The storage integration test creates an
isolated temporary repository from the same canonical layout so test commits never touch this
working tree.
