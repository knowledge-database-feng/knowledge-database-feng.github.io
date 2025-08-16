// This script loads researcher data from dataset.json and renders an
// interactive force‑directed graph using D3.js. Clicking a node
// displays detailed information in the adjacent details panel.

// Embed the dataset directly in the script to avoid cross‑origin issues when
// loading this page locally. If you wish to update the data, modify the
// `dataset` object below.
document.addEventListener('DOMContentLoaded', () => {
  /*
    Instead of loading the dataset from an external file via XHR (which
    fails under the file:// protocol), we read it from an embedded
    <script> tag with id="dataset-json".  This allows the page to
    include a large dataset inline. If the dataset cannot be parsed, we
    fall back to an empty dataset so the graph still renders without
    crashing.
  */
  const datasetEl = document.getElementById('dataset-json');
  let dataset = { nodes: [], links: [] };
  if (datasetEl) {
    try {
      dataset = JSON.parse(datasetEl.textContent);
    } catch (e) {
      console.error('Failed to parse embedded dataset JSON:', e);
    }
  } else if (window.dataset) {
    // Fallback: use dataset defined on the global object (e.g. from
    // dataset.js) if no embedded JSON script is present.
    dataset = window.dataset;
  }
  // Expose the dataset globally for other functions like showDetails()
  window.dataset = dataset;
  // Assign a country to each researcher based on their current or last
  // organisation.  We use a predefined mapping from organisation
  // names to country codes and then convert those codes to human
  // readable country names.  Countries that cannot be determined are
  // labelled "Unknown".  This property is required for the country
  // filter.
  assignCountry(dataset);
  // Augment the dataset with colleague relationships based on shared
  // organizations.  This step scans all researchers and adds a
  // relationship and link between any two researchers that share at
  // least one organization.  Details for these relationships are
  // generated to indicate which organizations they have in common.
  addColleagueRelationships(dataset);

  // Build a lookup map from id -> node for efficient access when
  // resolving relationships.  This map is attached to the dataset
  // object so it can be used elsewhere.
  dataset.nodeMap = {};
  dataset.nodes.forEach((node) => {
    dataset.nodeMap[node.id] = node;
  });

  renderGraph(dataset);
  setupSearch(dataset);
  populateOrgFilter(dataset);
  populateCountryFilter(dataset);
  populateRegionFilter(dataset);
  
  // Add a fallback to ensure the graph fits properly after a delay
  setTimeout(() => {
    if (window.resetView) {
      window.resetView();
    }
  }, 2000);

  // Set up reset button to clear filters and search input.  When
  // clicked, the organisation filter is set to "All organizations",
  // the country filter is set to "The World", the search input is
  // cleared and search results hidden.  Node colours are reset to
  // their category colours and all nodes/links are made fully
  // opaque via applyFilters().  The details panel is also reset to
  // its default message.
  const resetBtn = document.getElementById('reset-filters');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const orgSelect = document.getElementById('org-filter');
      const countrySelect = document.getElementById('country-filter');
      const searchInput = document.getElementById('search-input');
      const resultsList = document.getElementById('search-results');
      if (orgSelect) orgSelect.value = '';
      if (countrySelect) countrySelect.value = '';
      const regionSelect = document.getElementById('region-filter');
      if (regionSelect) regionSelect.value = '';
      if (searchInput) searchInput.value = '';
      if (resultsList) {
        resultsList.innerHTML = '';
        resultsList.style.display = 'none';
      }
      // Reset node colours based on category
      d3.selectAll('#graph-container svg .nodes circle').attr('fill', (d) =>
        d.category === 'industry' ? '#e67e22' : '#8e44ad'
      );
      // Remove any explicit opacity on nodes and labels by applying filters with no selections
      applyFilters(dataset);
      // Reset details panel to default message
      const detailsDiv = document.getElementById('details');
      if (detailsDiv) {
        detailsDiv.innerHTML =
          '<h2>Researcher Details</h2><p>Click nodes in the graph to view a researcher\'s biography and representative work.</p>';
      }
      // Reset the user selection flag to allow auto-fit again
      if (typeof userHasSelectedNode !== 'undefined') {
        userHasSelectedNode = false;
      }
    });
  }

  // Set up reset view button to show the entire graph
  const resetViewBtn = document.getElementById('reset-view');
  if (resetViewBtn) {
    resetViewBtn.addEventListener('click', () => {
      window.resetView();
    });
  }
});

function renderGraph(data) {
  const container = document.getElementById('graph-container');
  
  // Get the actual container dimensions
  const containerRect = container.getBoundingClientRect();
  const width = containerRect.width || 800;
  const height = containerRect.height || 600;

  // Clear any previous SVG (e.g. if re-rendering)
  d3.select('#graph-container').selectAll('*').remove();
  const svg = d3
    .select('#graph-container')
    .append('svg')
    .attr('width', width)
    .attr('height', height);
  // Create a group for all graph elements. We attach zoom and pan
  // behaviour to the SVG so users can explore the graph by dragging
  // and scrolling. The scaleExtent limits how far one can zoom in or
  // out (0.1x to 5x the original size).
  const g = svg.append('g').attr('class', 'zoom-group');
  // Set up zoom and pan behaviour on the SVG.  We store the zoom
  // instance in a variable so that we can programmatically control
  // the view (e.g., centre on a selected node).  The scaleExtent
  // limits how far one can zoom in or out.
  const zoom = d3
    .zoom()
    .scaleExtent([0.1, 5])
    .on('zoom', (event) => {
      g.attr('transform', event.transform);
    });
  svg.call(zoom);

  // Helper to fit the entire graph within the view on initial load.  This
  // computes the bounding box of all nodes and then calculates a
  // translation and scale so that the graph fills the available SVG
  // dimensions while leaving a small margin.  It is invoked when the
  // force simulation ends so that node positions have stabilised.  The
  // function references width, height, svg and zoom from the closure.
  function fitGraphToContainer() {
    // Compute extents of node positions
    const xExtent = d3.extent(data.nodes, (d) => d.x);
    const yExtent = d3.extent(data.nodes, (d) => d.y);
    // Handle cases where extents are undefined (e.g., no nodes)
    if (!xExtent || !yExtent || xExtent[0] === undefined || yExtent[0] === undefined) {
      return;
    }
    const graphWidth = xExtent[1] - xExtent[0] || 1;
    const graphHeight = yExtent[1] - yExtent[0] || 1;
    
    // Add generous padding to ensure we see the entire graph with margin
    const padding = 100;
    const graphWidthWithPadding = graphWidth + padding * 2;
    const graphHeightWithPadding = graphHeight + padding * 2;
    
    // Determine scale to fit graph within the SVG dimensions.  Use 95% of
    // available space to provide a closer, more detailed view of the nodes.
    const scale = Math.min(width / graphWidthWithPadding, height / graphHeightWithPadding) * 0.95;
    
    // Allow some zoom in on initial load for a larger default view
    const finalScale = Math.min(scale, 1.2);
    
    // Compute translation to centre the graph.  We translate the graph so
    // that its centre aligns with the centre of the SVG.
    const tx = width / 2 - (xExtent[0] + graphWidth / 2) * finalScale;
    const ty = height / 2 - (yExtent[0] + graphHeight / 2) * finalScale;
    
    // Apply the transform using d3.zoom.  Use a very short transition for quick loading.
    svg
      .transition()
      .duration(150)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(finalScale));
  }

  // Expose a helper to centre the view on a given node.  When a
  // researcher node is selected (and coloured green), calling this
  // function recentres the zoom/pan transform so that the node
  // appears in the middle of the viewport.  We capture the current
  // zoom transform to preserve the zoom scale.  The helper is
  // assigned to the global window object so it can be called from
  // other event handlers (search suggestions and link clicks).
  window.centerOnNode = function (node) {
    if (!node) return;
    // Mark that user has manually selected a node
    userHasSelectedNode = true;
    
    // Zoom in to a comfortable level for viewing the selected node
    const zoomLevel = 2.5; // Increased zoom level for better detail
    
    // Compute translation offsets so that the node appears at the centre
    // of the view.  Use the zoom level for positioning.
    const tx = width / 2 - node.x * zoomLevel;
    const ty = height / 2 - node.y * zoomLevel;
    
    svg
      .transition()
      .duration(750)
      .call(
        zoom.transform,
        d3.zoomIdentity.translate(tx, ty).scale(zoomLevel)
      );
  };

  // Expose a helper to reset the view to show the entire graph
  window.resetView = function () {
    // Reset the flag since user is manually resetting view
    userHasSelectedNode = false;
    // Force a more aggressive fit
    const xExtent = d3.extent(data.nodes, (d) => d.x);
    const yExtent = d3.extent(data.nodes, (d) => d.y);
    
    if (!xExtent || !yExtent || xExtent[0] === undefined || yExtent[0] === undefined) {
      return;
    }
    
    const graphWidth = xExtent[1] - xExtent[0] || 1;
    const graphHeight = yExtent[1] - yExtent[0] || 1;
    
    // Use very generous padding and smaller scale factor
    const padding = 150;
    const graphWidthWithPadding = graphWidth + padding * 2;
    const graphHeightWithPadding = graphHeight + padding * 2;
    
    // Use a larger scale factor for a more detailed view
    const scale = Math.min(width / graphWidthWithPadding, height / graphHeightWithPadding) * 0.85;
    const finalScale = Math.min(scale, 1.1);
    
    const tx = width / 2 - (xExtent[0] + graphWidth / 2) * finalScale;
    const ty = height / 2 - (yExtent[0] + graphHeight / 2) * finalScale;
    
    svg
      .transition()
      .duration(200)
      .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(finalScale));
  };

  // Assign random initial positions within a circle centred in the view.
  // This helps distribute the nodes throughout the area rather than
  // along the borders.  We use polar coordinates to generate points
  // uniformly within the circle of radius min(width, height) * 0.4.
  const radius = Math.min(width, height) * 0.4;
  data.nodes.forEach((d) => {
    const angle = Math.random() * 2 * Math.PI;
    const r = Math.sqrt(Math.random()) * radius;
    d.x = width / 2 + r * Math.cos(angle);
    d.y = height / 2 + r * Math.sin(angle);
  });
  // Define the simulation with link, charge, center and radial forces.
  // The radial force encourages nodes to reside within a circular
  // region centred in the view, helping to avoid clumping along
  // the edges.  Adjust the radius and strength values if the
  // distribution is not to your liking.
  const simulation = d3
    .forceSimulation(data.nodes)
    .force(
      'link',
      d3
        .forceLink(data.links)
        .id((d) => d.id)
        .distance(120)
    )
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force(
      'radial',
      d3
        .forceRadial(Math.min(width, height) * 0.3, width / 2, height / 2)
        .strength(0.2)
    );

  // Track if user has manually selected a node to prevent auto-reset
  let userHasSelectedNode = false;
  
  // Once the simulation has cooled and stopped, fit the graph to the
  // container.  Using the 'end' event ensures node positions are
  // reasonably settled before computing the bounding box.
  simulation.on('end', () => {
    // Minimal delay to ensure the simulation is fully settled
    setTimeout(() => {
      // Only auto-fit if user hasn't manually selected a node
      if (!userHasSelectedNode) {
        fitGraphToContainer();
      }
    }, 50);
  });

  // Draw links. Use the zoom group so zoom/pan transforms apply.
  const link = g
    .append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(data.links)
    .enter()
    .append('line')
    .attr('stroke', '#ccc')
    // Increase stroke width slightly to make edges easier to hover and set
    // pointer-events to visibleStroke so the line can capture mouse events
    // Use a thinner stroke for visible relationships so the graph
    // appears less cluttered.  Increase if edges become too faint.
    .attr('stroke-width', 4)
    .attr('pointer-events', 'all')
    .style('cursor', 'pointer');

  // Create an invisible overlay with a much thicker stroke to improve
  // clickability of relationship lines.  This overlay sits on top of the
  // visible links and captures mouse events.  Each overlay line is bound
  // to the same data as the visible link so we can handle hover and
  // click interactions easily.
  const linkOverlay = g
    .append('g')
    .attr('class', 'link-overlays')
    .selectAll('line')
    .data(data.links)
    .enter()
    .append('line')
    .attr('stroke', 'transparent')
    // A moderately thick transparent stroke ensures edges remain
    // clickable even though the visible line is thinner.
    .attr('stroke-width', 12)
    .attr('pointer-events', 'stroke')
    .style('cursor', 'pointer');

  // Create a tooltip div for displaying relationship information on edge hover
  const tooltip = d3
    .select('body')
    .append('div')
    .attr('class', 'tooltip')
    .style('position', 'absolute')
    .style('background', '#fff')
    .style('border', '1px solid #ccc')
    .style('padding', '6px')
    .style('border-radius', '4px')
    .style('box-shadow', '0 1px 3px rgba(0, 0, 0, 0.2)')
    .style('pointer-events', 'none')
    .style('display', 'none');

  // Provide a default title tooltip on each link so that hovering reveals
  // the relationship in a native browser tooltip. This ensures accessibility
  // even if custom tooltips fail to render.
  link.append('title').text((d) => {
    const sourceName = d.source.name || d.source.id;
    const targetName = d.target.name || d.target.id;
    let title = `${sourceName} – ${d.relationship.replace(/-/g, ' ')} – ${targetName}`;
    if (d.details) {
      title += `: ${d.details}`;
    }
    return title;
  });

  // Mirror the same titles on the overlay so that the native browser
  // tooltip appears when hovering over the thicker invisible line.
  linkOverlay.append('title').text((d) => {
    const sourceName = d.source.name || d.source.id;
    const targetName = d.target.name || d.target.id;
    let title = `${sourceName} – ${d.relationship.replace(/-/g, ' ')} – ${targetName}`;
    if (d.details) {
      title += `: ${d.details}`;
    }
    return title;
  });

  // Edge hover interactions to show relationship details using a custom
  // tooltip. Highlight the visible link on hover and move the tooltip with the
  // cursor. Hide the tooltip when the mouse leaves.  We attach these events
  // to the overlay because it has a large stroke width and is easier to
  // interact with. When hovering the overlay, highlight the corresponding
  // visible link and display the tooltip. On mouse out, restore the link
  // appearance and hide the tooltip.
  linkOverlay
    .on('mouseover', function (event, d) {
      // Highlight corresponding visible link
      link
        .filter((l) => l === d)
        .attr('stroke', '#f1948a')
        .attr('stroke-width', 6);
      const sourceName = d.source.name || d.source.id;
      const targetName = d.target.name || d.target.id;
      const typeText = d.relationship.replace(/-/g, ' ');
      // Build tooltip HTML with optional relationship details
      let tooltipHtml = `<strong>${sourceName}</strong> – ${typeText} – <strong>${targetName}</strong>`;
      if (d.details) {
        tooltipHtml += `<br><em>${d.details}</em>`;
      }
      tooltip
        .style('display', 'block')
        .html(tooltipHtml)
        .style('left', event.pageX + 10 + 'px')
        .style('top', event.pageY + 10 + 'px');
    })
    .on('mousemove', function (event) {
      tooltip
        .style('left', event.pageX + 10 + 'px')
        .style('top', event.pageY + 10 + 'px');
    })
    .on('mouseout', function (event, d) {
      // Restore the visible link appearance
      link
        .filter((l) => l === d)
        .attr('stroke', '#ccc')
        .attr('stroke-width', 4);
      tooltip.style('display', 'none');
    });

  // Click on a relationship line shows relationship details in the details panel.
  linkOverlay.on('click', function (event, d) {
    // Reset all node colors based on their category.  We select the
    // circles directly instead of referring to the `node` variable to
    // avoid referencing an undefined variable if this handler executes
    // before nodes are created.
    d3.selectAll('#graph-container svg .nodes circle').attr('fill', (n) =>
      n.category === 'industry' ? '#e67e22' : '#8e44ad'
    );
    // Highlight the two nodes involved in this relationship
    d3.selectAll('#graph-container svg .nodes circle')
      .filter((n) => n.id === d.source.id || n.id === d.target.id)
      .attr('fill', '#2ecc71');
    // Display relationship information in the details panel, including any
    // additional description about the collaboration or overlap.
    const detailsDiv = document.getElementById('details');
    const sourceName = d.source.name || d.source.id;
    const targetName = d.target.name || d.target.id;
    const typeText = d.relationship.replace(/-/g, ' ');
    let html = `<h2>${sourceName} &amp; ${targetName}</h2>`;
    html += `<p><strong>Relationship:</strong> ${typeText}</p>`;
    if (d.details) {
      html += `<p>${d.details}</p>`;
    }
    detailsDiv.innerHTML = html;

    // Centre the view on the first node in this relationship.  This
    // helps bring the highlighted nodes into focus when an edge is
    // clicked.
    if (typeof centerOnNode === 'function') {
      // If d.source is an object with x/y coordinates, centre on it; otherwise
      // look up the node via its id in the dataset.
      const nodeObj = typeof d.source === 'object' ? d.source : dataset.nodeMap[d.source];
      centerOnNode(nodeObj);
    }
  });

  // Compute a scale for node radius based on citation count.
  // We use the citations property on each node so researchers with more citations
  // appear larger.  Use a square root scale to tame the range and prevent
  // extremely large nodes.  Provide sensible defaults if all nodes have
  // the same count or no citations data.
  const citationExtent = d3.extent(data.nodes, (d) => {
    return typeof d.citations === 'number' && isFinite(d.citations) ? d.citations : 1;
  });
  const minCitations = citationExtent[0] === citationExtent[1] ? Math.max(citationExtent[0] - 1, 0) : citationExtent[0];
  const maxCitations = citationExtent[0] === citationExtent[1] ? citationExtent[1] + 1 : citationExtent[1];
  const radiusScale = d3.scaleSqrt().domain([minCitations, maxCitations]).range([4, 28]);

  // Draw nodes.  Set the radius based on the citation count so that
  // researchers with more citations stand out.  Colour nodes based on their
  // category (industry vs academia).
  const node = g
    .append('g')
    .attr('class', 'nodes')
    .attr('stroke', '#fff')
    .attr('stroke-width', 1.5)
    .selectAll('circle')
    .data(data.nodes)
    .enter()
    .append('circle')
    .attr('r', (d) => {
      const value = typeof d.citations === 'number' && isFinite(d.citations) ? d.citations : 1;
      return radiusScale(value);
    })
    .attr('fill', (d) => (d.category === 'industry' ? '#e67e22' : '#8e44ad'))
    .call(
      d3
        .drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

  // Add text labels for each node. These labels are anchored to the nodes
  // themselves and do not intercept pointer events so dragging still works.
  const labels = g
    .append('g')
    .attr('class', 'labels')
    .selectAll('text')
    .data(data.nodes)
    .enter()
    .append('text')
    .attr('class', 'node-label')
    .attr('text-anchor', 'middle')
    .attr('dy', -20)
    .text((d) => d.name);

  // Click event to show details
  node.on('click', (event, d) => {
    // Mark that user has manually selected a node
    if (typeof userHasSelectedNode !== 'undefined') {
      userHasSelectedNode = true;
    }
    // Reset all node colors based on their category
    node.attr('fill', (n) => (n.category === 'industry' ? '#e67e22' : '#8e44ad'));
    // Highlight the selected node
    d3.select(event.currentTarget).attr('fill', '#2ecc71');
    showDetails(d);
    // Centre the view on the selected node so it moves into the
    // middle of the viewport.
    if (typeof centerOnNode === 'function') {
      centerOnNode(d);
    }
  });

  // Simulation tick update
  simulation.on('tick', () => {
    // Constrain positions to the viewbox
    node
      .attr('cx', (d) => d.x)
      .attr('cy', (d) => d.y);
    labels
      .attr('x', (d) => d.x)
      .attr('y', (d) => d.y);
    link
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);
    // Update overlay positions to match the visible links
    linkOverlay
      .attr('x1', (d) => d.source.x)
      .attr('y1', (d) => d.source.y)
      .attr('x2', (d) => d.target.x)
      .attr('y2', (d) => d.target.y);
  });
}

// Helper to render details in the side panel
function showDetails(researcher) {
  const detailsDiv = document.getElementById('details');
  // Build HTML content for researcher details in English and highlight current
  // organizations. Use dataset to resolve relationship targets to names.
  let html = `<h2>${researcher.name}</h2>`;
  // Life span
  html += `<p><strong>Life span:</strong> ${researcher.lifeSpan}</p>`;
  // Personal website (if available) - hidden but functional
  if (researcher.website) {
    html += `<p><strong><i class="fas fa-globe"></i> Website:</strong> <a href="${researcher.website}" target="_blank" rel="noopener">Visit Website</a></p>`;
  }

  // Google Scholar (if available) - hidden but functional
  if (researcher.scholarid) {
    const scholarUrl = `https://scholar.google.com/citations?user=${researcher.scholarid}`;
    html += `<p><strong><i class="fas fa-graduation-cap"></i> Google Scholar:</strong> <a href="${scholarUrl}" target="_blank" rel="noopener">View Profile</a></p>`;
    
    // Citations section under Google Scholar
    if (researcher.citations) {
      html += `<p><strong>Total Citations:</strong> ${researcher.citations.toLocaleString()}</p>`;
    } else {
      html += '<p><strong>Total Citations:</strong> <em>Not available</em></p>';
    }
  }
  // Organizations
  if (researcher.organizations && researcher.organizations.length > 0) {
    html += '<h3><i class="fas fa-building"></i> Organizations</h3><ul>';
    researcher.organizations.forEach((org) => {
      // Highlight current organizations (period includes "present" case‑insensitively)
      const isCurrent = /present/i.test(org.period);
      const item = `${org.name} (${org.period})`;
      html += isCurrent
        ? `<li class="current-org">${item}</li>`
        : `<li>${item}</li>`;
    });
    html += '</ul>';
  }
  // Representative works
  if (
    researcher.representativeWorks &&
    researcher.representativeWorks.length > 0
  ) {
    html += '<h3><i class="fas fa-book-open"></i> Representative Works</h3><ul>';
    researcher.representativeWorks.forEach((work) => {
      let workText = `${work.title}`;
      if (work.year) workText += `, ${work.year}`;
      if (work.awards && work.awards.length > 0) {
        workText += ' — Awards: ' + work.awards.join(', ');
      }
      html += `<li>${workText}</li>`;
    });
    html += '</ul>';
  }
  // Awards
  if (researcher.awards && researcher.awards.length > 0) {
    html += '<h3><i class="fas fa-medal"></i> Awards</h3><ul>';
    researcher.awards.forEach((award) => {
      html += `<li>${award}</li>`;
    });
    html += '</ul>';
  }
  // Relationships
  if (researcher.relationships && researcher.relationships.length > 0) {
    html += '<h3><i class="fas fa-user-friends"></i> Relationships</h3><ul>';
    researcher.relationships.forEach((rel) => {
      // Look up the target researcher via the dataset's nodeMap for
      // efficient resolution. Fall back to linear search if the map is
      // unavailable (should not happen once the dataset is initialised).
      const nodeMap = window.dataset && window.dataset.nodeMap;
      const targetObj = nodeMap ? nodeMap[rel.target] : window.dataset.nodes.find((n) => n.id === rel.target);
      const targetName = targetObj ? targetObj.name : rel.target;
      // Replace hyphens with spaces for nicer reading
      const typeText = rel.type.replace(/-/g, ' ');
      // If a details property exists, append it after a dash for context.
      if (rel.details) {
        html += `<li>${typeText} with ${targetName} — ${rel.details}</li>`;
      } else {
        html += `<li>${typeText} with ${targetName}</li>`;
      }
    });
    html += '</ul>';
  }
  detailsDiv.innerHTML = html;
}

// --- Search functionality ---
// Compute the Levenshtein distance between two strings. This helper is used
// to rank search results by similarity when the query is not a simple
// substring match. A smaller distance means more similar strings.
function levenshtein(a, b) {
  const matrix = [];
  const aLen = a.length;
  const bLen = b.length;
  // Initialize the first row and column
  for (let i = 0; i <= aLen; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= bLen; j++) {
    matrix[0][j] = j;
  }
  // Compute distances
  for (let i = 1; i <= aLen; i++) {
    for (let j = 1; j <= bLen; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[aLen][bLen];
}

// Add colleague relationships between researchers who share one or more
// organizations.  For every pair of researchers with at least one
// overlapping organization name AND time overlap, a new link with relationship
// "colleague" is created if one does not already exist.
// The details field records the organization names where they overlapped.
// "present" is treated as a specific point in time (current year) for overlap calculations.
function addColleagueRelationships(dataset) {
  // Map organization name -> list of researcher nodes with their time periods
  const orgMap = {};
  dataset.nodes.forEach((node) => {
    if (node.organizations) {
      node.organizations.forEach((org) => {
        // Use the sanitized organisation name (without parentheses)
        // for grouping colleagues.  This ensures researchers with
        // different titles at the same institution are considered
        // colleagues.  Fallback to the full name if sanitized is not
        // available.
        const name = org.sanitized || org.name;
        if (!orgMap[name]) orgMap[name] = [];
        orgMap[name].push({ node, org });
      });
    }
    // Ensure the relationships array exists on every node
    if (!Array.isArray(node.relationships)) {
      node.relationships = [];
    }
  });
  
  // Filter out organizations where researchers don't have valid colleague relationships
  // This prevents creating links for organizations where they were in different time periods
  const filteredOrgMap = {};
  Object.entries(orgMap).forEach(([orgName, list]) => {
    const validPairs = [];
    
    // Check each pair of researchers at this organization
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        
        // Only include this pair if they should be colleagues
        if (shouldCreateColleagueLink(a.org.period, b.org.period)) {
          validPairs.push({ a, b });
        }
      }
    }
    
    // Only keep organizations that have valid colleague pairs
    if (validPairs.length > 0) {
      filteredOrgMap[orgName] = list;
    }
  });
  
  // Use the filtered organization map
  const finalOrgMap = filteredOrgMap;
  
  // Helper function to check if two time periods overlap
  function shouldCreateColleagueLink(period1, period2) {
    // Parse periods like "1991–1992", "2005–2007", "1993–present", "present-present", etc.
    const parsePeriod = (period) => {
      if (!period) return { start: null, end: null };
      
      // Handle "present" case - treat as a specific point in time
      if (period === "present") {
        // For now, treat "present" as a specific year (will be updated later)
        const currentYear = new Date().getFullYear();
        return { start: currentYear, end: currentYear };
      }
      
      // Handle "present-present" case - treat as current year to current year
      if (period === "present-present") {
        const currentYear = new Date().getFullYear();
        return { start: currentYear, end: currentYear };
      }
      
      const parts = period.split('–');
      if (parts.length !== 2) return { start: null, end: null };
      
      const start = parseInt(parts[0]);
      // Handle end period - check if it contains "present" (with or without parentheses)
      let end;
      if (parts[1].includes("present")) {
        end = new Date().getFullYear();
      } else {
        end = parseInt(parts[1]);
      }
      
      if (isNaN(start) || isNaN(end)) return { start: null, end: null };
      
      return { start, end };
    };
    
    const time1 = parsePeriod(period1);
    const time2 = parsePeriod(period2);
    
    // If we can't parse the periods, assume no overlap for safety
    if (!time1.start || !time2.start || !time1.end || !time2.end) {
      return false;
    }
    
    // Check for overlap: (start1 <= end2) && (start2 <= end1)
    return (time1.start <= time2.end) && (time2.start <= time1.end);
  }
  
  // Build a set of existing link pairs (source|target) to avoid
  // duplicating relationships already defined in the dataset.  We use
  // sorted keys so that (A,B) and (B,A) are considered the same pair.
  const existingPairs = new Set();
  dataset.links.forEach((link) => {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const key = srcId < tgtId ? `${srcId}|${tgtId}` : `${tgtId}|${srcId}`;
    existingPairs.add(key);
  });
  
  // Temporary structure to accumulate organizations shared by each pair
  const pairDetails = {};
  Object.entries(finalOrgMap).forEach(([orgName, list]) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        
        // Double-check time overlap for this specific pair
        if (!shouldCreateColleagueLink(a.org.period, b.org.period)) {
          continue; // Skip if no time overlap
        }
        
        const key = a.node.id < b.node.id ? `${a.node.id}|${b.node.id}` : `${b.node.id}|${a.node.id}`;
        // Skip if this pair already has a defined relationship in the
        // dataset links to avoid duplicating edges.
        if (existingPairs.has(key)) continue;
        if (!pairDetails[key]) {
          pairDetails[key] = { source: a.node.id, target: b.node.id, orgs: [] };
        }
        pairDetails[key].orgs.push(orgName);
      }
    }
  });
  // Convert accumulated pairs into actual links and append them to
  // dataset.links.  Also append corresponding entries to each
  // researcher's relationships list.
  Object.values(pairDetails).forEach((pd) => {
    const detailsText = pd.orgs.length === 1
      ? `Colleagues at ${pd.orgs[0]}`
      : `Colleagues at ${pd.orgs.join(', ')}`;
    dataset.links.push({
      source: pd.source,
      target: pd.target,
      relationship: 'colleague',
      details: detailsText,
    });
    // Add reciprocal relationships to nodes
    const srcNode = dataset.nodeMap ? dataset.nodeMap[pd.source] : dataset.nodes.find((n) => n.id === pd.source);
    const tgtNode = dataset.nodeMap ? dataset.nodeMap[pd.target] : dataset.nodes.find((n) => n.id === pd.target);
    if (srcNode) {
      srcNode.relationships.push({ target: pd.target, type: 'colleague', details: detailsText });
    }
    if (tgtNode) {
      tgtNode.relationships.push({ target: pd.source, type: 'colleague', details: detailsText });
    }
  });
}

// Given a query string, return the top N researcher nodes ranked by
// similarity. Results with names containing the query as a substring are
// prioritized over those where only the distance metric applies.
function searchResearchers(query, data, maxResults = 5) {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const scores = data.nodes.map((node) => {
    const name = node.name.toLowerCase();
    let score;
    if (name.includes(q)) {
      // Substring matches get a high score based on inverse of distance
      const dist = name.indexOf(q);
      // Lower index (earlier match) yields slightly higher score
      score = 1 + (q.length / (dist + 1));
    } else {
      // Use Levenshtein distance to compute similarity; add 1 to avoid division by zero
      const dist = levenshtein(name, q);
      score = 1 / (dist + 1);
    }
    return { node, score };
  });
  // Sort descending by score and take top results
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, maxResults).map((entry) => entry.node);
}

// Populate the organization filter dropdown with unique organization names
// extracted from the dataset.  The first option represents "All" and
// keeps the graph unfiltered.  Organizations are sorted alphabetically.
function populateOrgFilter(dataset) {
  const select = document.getElementById('org-filter');
  if (!select) return;
  // Collect unique organization names (sanitized) so that titles in
  // parentheses are ignored when populating the filter.  If a
  // sanitized name is unavailable, fall back to the full name.
  const orgSet = new Set();
  dataset.nodes.forEach((node) => {
    if (Array.isArray(node.organizations)) {
      node.organizations.forEach((org) => {
        const name = org.sanitized || org.name;
        orgSet.add(name);
      });
    }
  });
  const orgs = Array.from(orgSet).sort((a, b) => a.localeCompare(b));
  // Clear existing options except the first ("All organizations")
  select.options.length = 1;
  orgs.forEach((orgName) => {
    const opt = document.createElement('option');
    opt.value = orgName;
    opt.textContent = orgName;
    select.appendChild(opt);
  });
  // Listen for changes on the filter and reapply filters when selected.
  select.addEventListener('change', () => {
    applyFilters(dataset);
  });
}

// Populate the country filter dropdown with the list of unique countries.
// The first option is "The World", which displays all researchers.  A
// country is derived from the organisation mapping performed in
// assignCountry().  If no organisations map to a country, the
// researcher will have country "Unknown" and will appear when
// "Unknown" is selected.
function populateCountryFilter(dataset) {
  const select = document.getElementById('country-filter');
  if (!select) return;
  // Collect unique countries
  const countrySet = new Set();
  dataset.nodes.forEach((node) => {
    if (node.country) {
      countrySet.add(node.country);
    }
  });
  const countries = Array.from(countrySet).sort((a, b) => a.localeCompare(b));
  // Clear existing options except the first ("The World")
  select.options.length = 1;
  countries.forEach((countryName) => {
    const opt = document.createElement('option');
    opt.value = countryName;
    opt.textContent = countryName;
    select.appendChild(opt);
  });
  // Listen for changes on the filter and reapply filters when selected.
  select.addEventListener('change', () => {
    applyFilters(dataset);
  });
}

// Populate the region filter with unique region values from the dataset.
// The "All regions" option corresponds to an empty value.  When a
// region is selected, applyFilters() is called to update the view.
function populateRegionFilter(dataset) {
  const select = document.getElementById('region-filter');
  if (!select) return;
  const regionSet = new Set();
  dataset.nodes.forEach((node) => {
    if (node.region) {
      regionSet.add(node.region);
    }
  });
  const regions = Array.from(regionSet).sort((a, b) => a.localeCompare(b));
  // Clear existing options except the first
  select.options.length = 1;
  regions.forEach((regionName) => {
    const opt = document.createElement('option');
    opt.value = regionName;
    opt.textContent = regionName;
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    applyFilters(dataset);
  });
}

// Apply both organisation and country filters.  A node matches if it
// belongs to the selected organisation (or no organisation is
// selected) and its country matches the selected country (or "The
// World" is selected).  Nodes that do not match are dimmed along with
// their labels.  Links and overlays are shown if both of their
// endpoint nodes match.
function applyFilters(dataset) {
  const orgSelect = document.getElementById('org-filter');
  const countrySelect = document.getElementById('country-filter');
  const regionSelect = document.getElementById('region-filter');
  const selectedOrg = orgSelect ? orgSelect.value : '';
  const selectedCountry = countrySelect ? countrySelect.value : '';
  const selectedRegion = regionSelect ? regionSelect.value : '';
  function nodeMatches(node) {
    let orgMatch = true;
    if (selectedOrg) {
      orgMatch =
        Array.isArray(node.organizations) &&
        node.organizations.some((o) => {
          const base = o.sanitized || o.name;
          return base === selectedOrg;
        });
    }
    let countryMatch = true;
    if (selectedCountry) {
      countryMatch = node.country === selectedCountry;
    }
    let regionMatch = true;
    if (selectedRegion) {
      regionMatch = node.region === selectedRegion;
    }
    return orgMatch && countryMatch && regionMatch;
  }
  // Update node opacity
  d3.selectAll('#graph-container svg .nodes circle').style('opacity', (d) => (nodeMatches(d) ? 1 : 0.2));
  // Update label opacity
  d3.selectAll('#graph-container svg .labels text').style('opacity', (d) => (nodeMatches(d) ? 1 : 0.2));
  // Update link opacity: visible only if both source and target match
  d3.selectAll('#graph-container svg .links line').style('opacity', (link) => {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcNode = dataset.nodeMap[srcId];
    const tgtNode = dataset.nodeMap[tgtId];
    return nodeMatches(srcNode) && nodeMatches(tgtNode) ? 1 : 0.05;
  });
  d3.selectAll('#graph-container svg .link-overlays line').style('opacity', (link) => {
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcNode = dataset.nodeMap[srcId];
    const tgtNode = dataset.nodeMap[tgtId];
    return nodeMatches(srcNode) && nodeMatches(tgtNode) ? 1 : 0.05;
  });
}

// Apply an organization filter to the graph.  When a specific
// organization is selected, only researchers affiliated with that
// organization will be fully opaque; others are dimmed.  Links and
// labels are also adjusted.  When no organization is selected, all
// elements are reset to full opacity.
function applyOrgFilter(orgName, dataset) {
  // Determine if a node belongs to the selected organization
  function nodeBelongsToOrg(node) {
    if (!orgName) return true;
    return Array.isArray(node.organizations) && node.organizations.some((o) => o.name === orgName);
  }
  // Update node opacity
  d3.selectAll('#graph-container svg .nodes circle').style('opacity', (d) => (nodeBelongsToOrg(d) ? 1 : 0.2));
  // Update label opacity
  d3.selectAll('#graph-container svg .labels text').style('opacity', (d) => (nodeBelongsToOrg(d) ? 1 : 0.2));
  // Update link opacity.  A link is fully visible only if both
  // connected nodes belong to the selected organization.
  d3.selectAll('#graph-container svg .links line').style('opacity', (link) => {
    if (!orgName) return 1;
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcNode = dataset.nodeMap[srcId];
    const tgtNode = dataset.nodeMap[tgtId];
    return nodeBelongsToOrg(srcNode) && nodeBelongsToOrg(tgtNode) ? 1 : 0.05;
  });
  // Update link overlay opacity similarly
  d3.selectAll('#graph-container svg .link-overlays line').style('opacity', (link) => {
    if (!orgName) return 1;
    const srcId = typeof link.source === 'object' ? link.source.id : link.source;
    const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
    const srcNode = dataset.nodeMap[srcId];
    const tgtNode = dataset.nodeMap[tgtId];
    return nodeBelongsToOrg(srcNode) && nodeBelongsToOrg(tgtNode) ? 1 : 0.05;
  });
}

// Assign a country property to each researcher in the dataset.  We
// maintain a mapping from organisation names to ISO 3166‑1 alpha‑2
// country codes and a separate mapping from codes to human‑readable
// names.  When determining a researcher’s country, we look for a
// current organisation (one whose period contains "present"); if
// none exists we fall back to the last organisation in the list.
// Researchers whose organisations are not in the mapping are
// labelled "Unknown".  The resulting country names are used by the
// country filter.
function assignCountry(dataset) {
  // Map organisation names to country codes.  Only the organisations
  // present in the dataset need to be listed here.  You can extend
  // this object as you add more organisations to the dataset.
  const orgToCode = {
    'University of Montreal': 'CA',
    'Zhejiang University': 'CN',
    'Chinese University of Hong Kong': 'HK',
    'Seoul National University': 'KR',
    'HKUST': 'HK',
    'KAIST': 'KR',
    'Nanyang Technological University': 'SG',
    'University of Toronto': 'CA',
    'Chinese Academy of Sciences': 'CN',
    'Shanghai Jiao Tong University': 'CN',
    'Peking University': 'CN',
    'University of Illinois at Urbana–Champaign': 'US',
    'Carnegie Mellon University': 'US',
    'Stanford University': 'US',
    'Princeton University': 'US',
    'NEC Research Institute (Fellow)': 'US',
    'Bell Labs (Adaptive Systems Research)': 'US',
    'AT&T Labs (Head, Image Processing Research)': 'US',
    'Facebook/Meta AI (Director/Vice President & Chief AI Scientist)': 'US',
    'Massachusetts Institute of Technology (Postdoctoral Fellow)': 'US',
    'New York University': 'US',
    'Vector Institute': 'CA',
    'Bell Labs (Postdoctoral Fellow)': 'US',
    'Google Cloud (Vice President & Chief AI/ML Scientist)': 'US',
    'Google (Engineering Fellow)': 'US',
    'World Labs (Co‑founder/CEO)': 'US'
  };
  // Map country codes to full country names.  Only a subset of
  // countries appears in our dataset.  Extend this mapping as
  // necessary when new codes are introduced.
  const codeToName = {
    CA: 'Canada',
    CN: 'China',
    HK: 'Hong Kong',
    KR: 'South Korea',
    SG: 'Singapore',
    US: 'United States'
  };
  dataset.nodes.forEach((node) => {
    // Compute sanitized names for each organisation on this node.  The
    // sanitized name is the substring before the first opening
    // parenthesis, trimmed of whitespace.  This is used for
    // grouping colleagues and mapping organisations to countries.  If
    // no parenthesis is present, the original name is used.  We
    // attach the sanitized name directly to the organisation object.
    if (Array.isArray(node.organizations)) {
      node.organizations.forEach((org) => {
        if (typeof org.name === 'string') {
          const idx = org.name.indexOf('(');
          org.sanitized = idx >= 0 ? org.name.substring(0, idx).trim() : org.name.trim();
        }
      });
    }
    // If the dataset has already assigned a country (e.g. via the
    // embedded dataset.js), respect that value unless it is
    // explicitly "Unknown" or empty.  This allows precomputed
    // country assignments to persist while still computing sanitized
    // organisation names for filtering and colleagues.  Only compute a
    // country here if none is provided.
    if (node.country && node.country !== 'Unknown') {
      return;
    }
    let countryName = 'Unknown';
    if (Array.isArray(node.organizations) && node.organizations.length > 0) {
      // Prefer a current organisation; otherwise the last one.
      let currentOrg = node.organizations.find((o) =>
        typeof o.period === 'string' && o.period.toLowerCase().includes('present')
      );
      if (!currentOrg) {
        currentOrg = node.organizations[node.organizations.length - 1];
      }
      // Use the sanitized organisation name for mapping to a country code.
      const baseName = currentOrg && currentOrg.sanitized ? currentOrg.sanitized : currentOrg.name;
      const code = orgToCode[baseName];
      if (code) {
        countryName = codeToName[code] || code;
      }
    }
    node.country = countryName;
  });
}

function setupSearch(data) {
  const searchInput = document.getElementById('search-input');
  const resultsList = document.getElementById('search-results');
  if (!searchInput || !resultsList) return;
  // Hide results initially
  resultsList.style.display = 'none';
  
  // Add ESC key functionality to hide search results
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      resultsList.style.display = 'none';
      searchInput.blur(); // Remove focus from input
    }
  });
  
  searchInput.addEventListener('input', (event) => {
    const query = event.target.value;
    // Clear any previous results
    resultsList.innerHTML = '';
    if (!query.trim()) {
      resultsList.style.display = 'none';
      return;
    }
    const results = searchResearchers(query, data, 5);
    if (results.length === 0) {
      resultsList.style.display = 'none';
      return;
    }
    // Populate the list with result items
    results.forEach((node) => {
      const li = document.createElement('li');
      li.textContent = node.name;
      li.addEventListener('click', () => {
        // When a suggestion is clicked, highlight node and show details
        // Reset all node colors based on their category
        d3.selectAll('#graph-container svg .nodes circle').attr('fill', (d) =>
          d.category === 'industry' ? '#e67e22' : '#8e44ad'
        );
        // Find the clicked node element via its id and highlight it
        d3.selectAll('#graph-container svg .nodes circle')
          .filter((d) => d.id === node.id)
          .attr('fill', '#2ecc71');
        showDetails(node);
        // Centre on the selected node
        if (typeof centerOnNode === 'function') {
          centerOnNode(node);
        }
        // Clear search input and results
        searchInput.value = '';
        resultsList.innerHTML = '';
        resultsList.style.display = 'none';
      });
      resultsList.appendChild(li);
    });
    resultsList.style.display = 'block';
  });
}