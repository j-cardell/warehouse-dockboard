// Yard Slot Drag and Drop (edit mode)
let draggedSlotId = null;

function setupYardSlotDragAndDrop(list) {
  const slots = list.querySelectorAll('.yard-slot-draggable');
  
  slots.forEach(slot => {
    slot.addEventListener('dragstart', (e) => {
      draggedSlotId = slot.dataset.slotId;
      slot.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedSlotId);
    });
    
    slot.addEventListener('dragend', () => {
      slot.classList.remove('dragging');
      draggedSlotId = null;
      list.querySelectorAll('.drag-over').forEach(d => d.classList.remove('drag-over'));
    });
    
    slot.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (draggedSlotId && draggedSlotId !== slot.dataset.slotId) {
        slot.classList.add('drag-over');
      }
    });
    
    slot.addEventListener('dragleave', () => {
      slot.classList.remove('drag-over');
    });
    
    slot.addEventListener('drop', async (e) => {
      e.preventDefault();
      slot.classList.remove('drag-over');
      
      const sourceId = e.dataTransfer.getData('text/plain');
      const targetId = slot.dataset.slotId;
      
      if (!sourceId || sourceId === targetId) return;
      
      // Reorder slots locally
      const sourceIndex = state.yardSlots.findIndex(s => s.id === sourceId);
      const targetIndex = state.yardSlots.findIndex(s => s.id === targetId);
      
      if (sourceIndex === -1 || targetIndex === -1) return;
      
      // Get all slot IDs in current order sorted by number
      const sortedSlots = [...state.yardSlots].sort((a, b) => a.number - b.number);
      const slotIds = sortedSlots.map(s => s.id);
      
      // Move source to position after target
      const sourcePos = slotIds.indexOf(sourceId);
      const targetPos = slotIds.indexOf(targetId);
      
      slotIds.splice(sourcePos, 1);  // Remove from old position
      slotIds.splice(targetPos, 0, sourceId);  // Insert at new position
      
      // Update server with new order
      try {
        showToast('Reordering yard slots...', 'info');
        await reorderYardSlots(slotIds);
        showToast('Yard slot order saved', 'success');
        fetchState();  // Refresh state
      } catch (error) {
        showToast('Failed to reorder yard slots: ' + error.message, 'error');
      }
    });
  });
}

// Open modal to add new yard slot
function openAddYardSlotModal() {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-add-yard-slot';
  
  // Find next available slot number
  const existingNumbers = state.yardSlots.map(s => s.number);
  const nextNumber = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
  
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>➕ Add New Yard Slot</h3>
        <button class="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Slot Number</label>
          <input type="number" id="new-yard-slot-number" value="${nextNumber}" placeholder="e.g., ${nextNumber}" style="width:100%; padding:0.5rem; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm); color:var(--text-primary);">
          <small style="color:var(--text-muted); margin-top:0.25rem; display:block;">Enter a unique slot number (e.g., 31, 32, etc.)</small>
        </div>
        <div class="modal-actions">
          <button id="btn-create-yard-slot" class="btn btn-primary">➕ Create Slot</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  const numberInput = document.getElementById('new-yard-slot-number');
  
  document.getElementById('btn-create-yard-slot')?.addEventListener('click', async () => {
    const number = parseInt(numberInput?.value);
    
    if (!number || isNaN(number)) {
      showToast('Please enter a valid slot number', 'warning');
      return;
    }
    
    // Check for duplicates
    if (state.yardSlots.find(s => s.number === number)) {
      showToast(`Slot number ${number} already exists`, 'error');
      return;
    }
    
    try {
      const result = await createYardSlot({ number });
      showToast(`Yard slot ${number} created!`, 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  // Enter key to submit
  numberInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-create-yard-slot')?.click();
    }
  });
  
  // Focus the input
  setTimeout(() => numberInput?.focus(), 100);
}

// Open modal to edit yard slot
function openEditYardSlotModal(slot) {
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'modal-edit-yard-slot';
  
  const trailer = slot.trailerId ? 
    state.trailers.find(t => t.id === slot.trailerId) || 
    state.yardTrailers.find(t => t.id === slot.trailerId) : null;
  
  modal.innerHTML = `
    <div class="modal-content">
      <div class="modal-header">
        <h3>⚙️ Edit Yard Slot</h3>
        <button class="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Slot Number</label>
          <input type="number" id="edit-yard-slot-number" value="${slot.number}" style="width:100%; padding:0.5rem; background:var(--bg-primary); border:1px solid var(--border-color); border-radius:var(--radius-sm); color:var(--text-primary);">
          ${trailer ? `<small style="color:var(--text-muted); margin-top:0.25rem; display:block;">⚠️ This slot contains a trailer (${trailer.carrier})</small>` : ''}
        </div>
        <div class="modal-actions">
          <button id="btn-save-yard-slot" class="btn btn-primary">💾 Save Changes</button>
          <button id="btn-delete-yard-slot" class="btn btn-danger">🗑️ Delete Slot</button>
          <button class="btn btn-secondary close-modal">Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  modal.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => modal.remove());
  });
  
  const numberInput = document.getElementById('edit-yard-slot-number');
  
  document.getElementById('btn-save-yard-slot')?.addEventListener('click', async () => {
    const newNumber = parseInt(numberInput?.value);
    
    if (!newNumber || isNaN(newNumber)) {
      showToast('Please enter a valid slot number', 'warning');
      return;
    }
    
    if (newNumber === slot.number) {
      modal.remove();
      return;
    }
    
    // Check for duplicates
    if (state.yardSlots.find(s => s.number === newNumber && s.id !== slot.id)) {
      showToast(`Slot number ${newNumber} already exists`, 'error');
      return;
    }
    
    try {
      await updateYardSlot(slot.id, { number: newNumber });
      showToast(`Yard slot updated to ${newNumber}`, 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  document.getElementById('btn-delete-yard-slot')?.addEventListener('click', async () => {
    if (trailer) {
      if (!confirm(`Slot ${slot.number} contains a trailer (${trailer.carrier} ${trailer.number || ''}).\n\nDelete slot and move trailer to unassigned yard?`)) {
        return;
      }
    } else {
      if (!confirm(`Delete yard slot ${slot.number}?\n\nThis cannot be undone.`)) {
        return;
      }
    }
    
    try {
      await deleteYardSlotAPI(slot.id);
      showToast('Yard slot deleted', 'success');
      modal.remove();
      fetchState();
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
  
  // Enter key to submit
  numberInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('btn-save-yard-slot')?.click();
    }
  });
  
  // Focus the input
  setTimeout(() => numberInput?.focus(), 100);
}
